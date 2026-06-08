// ==UserScript==
// @name         WhatsApp Leads Sync → Base44
// @namespace    https://github.com/strugo7/whatsapp-leads-sync
// @version      1.2.0
// @description  קורא לידים מתויגים ב-WhatsApp Web (READ-ONLY) ושולח אותם ל-CRM ב-Base44. סנכרון בלחיצה בלבד.
// @author       strugo7
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @require      https://github.com/wppconnect-team/wa-js/releases/download/v4.3.0/wppconnect-wa.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      base44.app
// @updateURL    https://raw.githubusercontent.com/strugo7/whatsapp-leads-sync/main/whatsapp-leads-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/strugo7/whatsapp-leads-sync/main/whatsapp-leads-sync.user.js
// ==/UserScript==

/*
 * ──────────────────────────────────────────────────────────────────────────
 *  WhatsApp Leads Sync → Base44
 * ──────────────────────────────────────────────────────────────────────────
 *  כלי פרטי קטן: קורא צ'אטים שתויגו ידנית תחת תגית מסוימת ב-WhatsApp Web,
 *  ושולח כל ליד חדש ל-endpoint ב-CRM שב-Base44.
 *
 *  עקרונות מנחים (אל תחרוג מהם):
 *    • READ-ONLY מוחלט — הסקריפט אף פעם לא שולח הודעות ולא כותב/משנה תגיות.
 *      רק קריאות: WPP.labels.getAllLabels() ו-WPP.chat.list(). זה מה ששומר
 *      על המספר של החבר מחסימה.
 *    • ריצה לפי לחיצה בלבד, עם השהיה קצרה בין שליחות (קצב אנושי).
 *    • אין סודות בקוד — WEBHOOK_URL / SHARED_SECRET / LABEL_NAME נשמרים
 *      ב-GM storage דרך תפריט "הגדרות חיבור ל-CRM". לכן מותר לפרסם ציבורית.
 *
 *  לפני שימוש ראשון: ראה "Step 0" ב-README — בדיקת קונסול שמאמתת איפה wa-js
 *  מחזיק את תגיות הצ'אט בגרסה הספציפית שלך.
 * ──────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ───────────────────────────── מפתחות אחסון ─────────────────────────────
  const STORE = {
    WEBHOOK_URL: 'cfg_webhook_url',
    SHARED_SECRET: 'cfg_shared_secret',
    LABEL_NAME: 'cfg_label_name',
    DRY_RUN: 'cfg_dry_run',
  };

  // כל מפתחות האחסון המקומיים — לשימוש כפתור "מחק נתונים מקומיים".
  const ALL_STORE_KEYS = Object.values(STORE);

  const DEFAULT_LABEL_NAME = 'לידים חדשים לטיפול';

  // השהיה אנושית בין שליחות (מילישניות) — נבחר אקראי בטווח כדי לא להיראות כבוט.
  const SEND_DELAY_MIN_MS = 600;
  const SEND_DELAY_MAX_MS = 1200;

  // ───────────────────────────── עזרי config ─────────────────────────────
  const cfg = {
    get webhookUrl() {
      return (GM_getValue(STORE.WEBHOOK_URL, '') || '').trim();
    },
    get sharedSecret() {
      return (GM_getValue(STORE.SHARED_SECRET, '') || '').trim();
    },
    get labelName() {
      return (GM_getValue(STORE.LABEL_NAME, DEFAULT_LABEL_NAME) || DEFAULT_LABEL_NAME).trim();
    },
    // DRY_RUN ברירת מחדל: true (לא שולח כלום, רק מדפיס).
    get dryRun() {
      return GM_getValue(STORE.DRY_RUN, true);
    },
    isConfigured() {
      return Boolean(this.webhookUrl && this.sharedSecret);
    },
  };

  // ────────────────────────── פרטיות: עזרים ──────────────────────────────
  // אין שמירה מקומית של טלפונים כלל (אין dedup מקומי) — ה-dedup הסופי קורה
  // בשרת דרך upsert. מקומית אנחנו רק ממסכים טלפונים בקונסול וחותמים בקשות.
  function bytesToHex(buf) {
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // מיסוך טלפון לתצוגה בקונסול בלבד: +972***67 (לא חושף את המספר המלא).
  function maskPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length <= 4) return '***';
    return '+' + digits.slice(0, 3) + '***' + digits.slice(-2);
  }

  // חתימת HMAC-SHA256 על מחרוזת, מוחזרת כ-hex. הסוד משמש כמפתח ואינו נשלח ברשת.
  async function hmacSignHex(secret, message) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(message)
    );
    return bytesToHex(sig);
  }

  // ───────────────────────── תפריטי Tampermonkey ─────────────────────────
  GM_registerMenuCommand('הגדרות חיבור ל-CRM', openSettings);
  GM_registerMenuCommand('מצב הרצה (DRY_RUN / שליחה אמיתית)', toggleDryRun);
  GM_registerMenuCommand('בדיקת תגיות (Step 0)', runLabelDiagnostics);
  GM_registerMenuCommand('מחק נתונים מקומיים', clearLocalData);

  // Step 0 — בדיקת מבנה התגיות. רץ בתוך ההקשר של הסקריפט (שם WPP מוגדר), כי
  // הקונסול של הדף רץ בהקשר אחר ולכן לא רואה את WPP (ראה README). מדפיס לקונסול.
  async function runLabelDiagnostics() {
    try {
      console.log(
        '%c[Leads Sync] Step 0 — בדיקת תגיות',
        'font-weight:bold;font-size:14px'
      );
      const WPP = await waitForWPP();

      // 1) ה-API הזמין תחת WPP.labels בגרסת wa-js שלך
      console.log('WPP.labels keys:', Object.keys(WPP.labels).sort());

      // 2) רשימת התגיות (id + שם)
      const labels = (await WPP.labels.getAllLabels()) || [];
      console.table(labels.map((l) => ({ id: l.id, name: l.name })));

      // 3) מבנה התגיות בצ'אט לדוגמה — מדפיסים רק מפתחות ושדה labels, בלי לחשוף טלפון.
      const chats = (await WPP.chat.list()) || [];
      const sample = chats.find((c) => c && c.labels);
      if (sample) {
        console.log('מפתחות chat לדוגמה:', Object.keys(sample));
        console.log('chat.labels לדוגמה:', sample.labels);
      } else {
        console.log(
          'לא נמצא צ\'אט עם שדה labels — ייתכן שהמבנה שונה בגרסה שלך. בדוק Object.keys(chat) ועדכן את chatHasLabel().'
        );
      }

      // 4) כמה צ'אטים מזוהים תחת התגית המוגדרת (אימות הצינור מקצה לקצה)
      const label = labels.find((l) => String(l.name).trim() === cfg.labelName);
      if (!label) {
        console.warn('לא נמצאה תגית בשם:', cfg.labelName);
      } else {
        const count = chats.filter((c) =>
          chatHasLabel(c, String(label.id))
        ).length;
        console.log(
          'צ\'אטים שזוהו תחת התגית "' + cfg.labelName + '":',
          count
        );
      }
      alert('בדיקת Step 0 הסתיימה — פתח את ה-Console (F12) כדי לראות את התוצאות.');
    } catch (e) {
      console.error('[Leads Sync] שגיאה בבדיקה:', e);
      alert('שגיאה בבדיקה: ' + (e && e.message ? e.message : e));
    }
  }

  // מוחק את כל הנתונים המקומיים (URL, סוד, תגית, מצב). אפס עקבות במכשיר.
  function clearLocalData() {
    if (!confirm('למחוק את כל הנתונים המקומיים (URL, סוד, תגית, מצב)? פעולה בלתי הפיכה.')) {
      return;
    }
    for (const key of ALL_STORE_KEYS) {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
      else GM_setValue(key, ''); // fallback אם GM_deleteValue לא זמין
    }
    alert('כל הנתונים המקומיים נמחקו. הזן הגדרות מחדש דרך "הגדרות חיבור ל-CRM".');
  }

  function openSettings() {
    const url = prompt(
      'כתובת ה-Webhook של ה-CRM ב-Base44 (URL מלא, חייב HTTPS):',
      cfg.webhookUrl
    );
    if (url === null) return; // המשתמש ביטל
    GM_setValue(STORE.WEBHOOK_URL, url.trim());

    const secret = prompt(
      'הסוד המשותף (משמש לחתימת HMAC) — נשמר מקומית בלבד, ולא נשלח ברשת:',
      cfg.sharedSecret
    );
    if (secret !== null) GM_setValue(STORE.SHARED_SECRET, secret.trim());

    const label = prompt(
      'שם התגית לסנכרון (כפי שמופיע ב-WhatsApp):',
      cfg.labelName
    );
    if (label !== null) {
      GM_setValue(STORE.LABEL_NAME, (label.trim() || DEFAULT_LABEL_NAME));
    }

    alert(
      'ההגדרות נשמרו.\n\n' +
        'מצב נוכחי: ' +
        (cfg.dryRun ? 'DRY_RUN (לא שולח, רק מדפיס)' : 'שליחה אמיתית') +
        '\nתגית: ' +
        cfg.labelName
    );
  }

  function toggleDryRun() {
    const next = !cfg.dryRun;
    GM_setValue(STORE.DRY_RUN, next);
    alert(
      'מצב הרצה עודכן ל: ' +
        (next ? 'DRY_RUN — לא שולח כלום, רק מדפיס console.table' : 'שליחה אמיתית')
    );
  }

  // ──────────────────────────── המתנה ל-wa-js ─────────────────────────────
  // ממתינים עד ש-WPP נטען ומחובר (WhatsApp Web מאותחל).
  function waitForWPP(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (typeof window.WPP !== 'undefined' && window.WPP.isReady) {
          resolve(window.WPP);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('wa-js (WPP) לא נטען/לא מוכן בזמן.'));
          return;
        }
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randDelay = () =>
    SEND_DELAY_MIN_MS +
    Math.floor(Math.random() * (SEND_DELAY_MAX_MS - SEND_DELAY_MIN_MS + 1));

  // ──────────────────────── שליפת לידים (READ-ONLY) ───────────────────────
  // מחזיר מערך של { phone, name, wid } עבור הצ'אטים שתחת התגית.
  async function collectLeads(WPP) {
    const labelName = cfg.labelName;

    // 1) פותרים את ה-id של התגית לפי שם (READ).
    const labels = await WPP.labels.getAllLabels();
    const label = (labels || []).find(
      (l) => (l && l.name ? String(l.name).trim() : '') === labelName
    );
    if (!label) {
      throw new Error(
        'לא נמצאה תגית בשם "' + labelName + '". בדוק את שם התגית בהגדרות.'
      );
    }
    const labelId = String(label.id);

    // 2) שולפים את כל הצ'אטים ומסננים לפי חברות בתגית (READ).
    const chats = await WPP.chat.list();

    const leads = [];
    for (const chat of chats || []) {
      if (!chatHasLabel(chat, labelId)) continue;

      // טלפון מה-WID: כבר בפורמט בינלאומי קנוני (למשל 972501234567@c.us).
      // מוסיפים + בלבד — בלי נירמול ידני.
      const wid = chat.id;
      const user = wid && wid.user ? String(wid.user) : '';
      if (!user) continue;

      // מדלגים על קבוצות (WID של קבוצה אינו טלפון של ליד).
      const server = wid && wid.server ? String(wid.server) : '';
      if (server === 'g.us') continue;

      leads.push({
        phone: '+' + user,
        wid: user + '@' + (server || 'c.us'),
        name: chat.name || chat.formattedTitle || '',
      });
    }

    return leads;
  }

  // ⚠️ TODO: אמת מול גרסת wa-js שלך איפה יושבות תגיות הצ'אט — ראה Step 0 ב-README.
  // הדרך שבה כל chat מחזיק את התגיות שלו משתנה בין גרסאות wa-js.
  // נכון לגרסה היציבה (v4.3.0) הצ'אט בדרך כלל חושף מערך labels של מזהי תגיות,
  // אך ייתכן מבנה שונה (chat.labels כאובייקטים / chat.t / שדה אחר).
  // אם השליפה מחזירה 0 לידים — הרץ את Step 0 בקונסול והתאם את הפונקציה הזו.
  function chatHasLabel(chat, labelId) {
    if (!chat) return false;
    const raw = chat.labels;
    if (!raw) return false;

    // מנרמלים לכמה צורות אפשריות: מערך מזהים, מערך אובייקטים, או Map/אוסף.
    let list = raw;
    if (typeof raw.getModelsArray === 'function') list = raw.getModelsArray();
    else if (!Array.isArray(raw) && typeof raw === 'object') list = Object.values(raw);

    if (!Array.isArray(list)) return false;

    return list.some((item) => {
      if (item == null) return false;
      if (typeof item === 'string' || typeof item === 'number') {
        return String(item) === labelId;
      }
      if (typeof item === 'object') {
        const id = item.id != null ? item.id : item.labelId;
        return String(id) === labelId;
      }
      return false;
    });
  }

  // ───────────────────────────── שליחה ל-CRM ──────────────────────────────
  // אבטחה:
  //  • HTTPS בלבד (הטלפון מוצפן בתעבורה).
  //  • אימות דרך חתימת HMAC-SHA256 על (timestamp + "." + body) — הסוד עצמו
  //    אף פעם לא נשלח ברשת, רק החתימה. החותמת מאפשרת לשרת לדחות replay (חלון ~5 דק').
  //  • לא מתעדים את גוף התשובה (responseText) — הוא עלול להחזיר את הטלפון.
  async function postLead(lead) {
    const url = cfg.webhookUrl;
    if (!/^https:\/\//i.test(url)) {
      throw new Error('ה-Webhook חייב להיות HTTPS (כדי שהטלפון יישלח מוצפן).');
    }

    const body = JSON.stringify({
      phone: lead.phone,
      name: lead.name,
      source: 'whatsapp-web',
      synced_at: new Date().toISOString(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000)); // שניות מאז epoch
    const signature = await hmacSignHex(cfg.sharedSecret, timestamp + '.' + body);

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          'X-Timestamp': timestamp,
          'X-Signature': signature, // hex של HMAC-SHA256 — הסוד עצמו לא נשלח
        },
        data: body,
        timeout: 20000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve({ status: res.status });
          // ללא responseText — רק קוד הסטטוס, כדי לא להדליף PII ללוג/קונסול.
          else reject(new Error('HTTP ' + res.status));
        },
        onerror: () => reject(new Error('שגיאת רשת בשליחה')),
        ontimeout: () => reject(new Error('timeout בשליחה')),
      });
    });
  }

  // ─────────────────────────── זרימת הסנכרון ─────────────────────────────
  let isSyncing = false;

  async function syncLeads() {
    if (isSyncing) return;
    isSyncing = true;
    setBtnState('busy', 'מסנכרן…');

    try {
      if (!cfg.dryRun && !cfg.isConfigured()) {
        alert(
          'חסרות הגדרות. פתח את תפריט Tampermonkey → "הגדרות חיבור ל-CRM" והזן URL + סוד.'
        );
        return;
      }

      const WPP = await waitForWPP();
      const leads = await collectLeads(WPP);

      // אין dedup מקומי — לא שומרים כלום על המכשיר. ה-dedup הסופי הוא ה-upsert
      // בשרת (לפי טלפון), כך שאפשר לשלוח את אותו ליד שוב בלי ליצור כפילות.
      if (leads.length === 0) {
        setBtnState('idle', 'סנכרן לידים');
        alert('לא נמצאו צ\'אטים תחת התגית "' + cfg.labelName + '".');
        return;
      }

      // ── DRY_RUN: רק מדפיסים, לא שולחים כלום ──
      if (cfg.dryRun) {
        console.log(
          '%c[Leads Sync] DRY_RUN — לא נשלח כלום. הלידים שתחת התגית:',
          'font-weight:bold'
        );
        // מציגים טלפון ממוסך בלבד (לא המספר המלא), והשם לזיהוי הליד.
        console.table(
          leads.map((l) => ({ phone: maskPhone(l.phone), name: l.name }))
        );
        alert(
          'DRY_RUN: נמצאו ' +
            leads.length +
            ' לידים תחת התגית (ראה console.table). לא נשלח כלום.\n' +
            'להפעלת שליחה אמיתית: תפריט Tampermonkey → "מצב הרצה".'
        );
        return;
      }

      // ── שליחה אמיתית, אחד-אחד עם השהיה אנושית. השרת עושה upsert לפי טלפון. ──
      let okCount = 0;
      let failCount = 0;
      for (const lead of leads) {
        try {
          await postLead(lead);
          okCount++;
        } catch (e) {
          failCount++;
          // טלפון ממוסך בלבד בקונסול, ורק הודעת השגיאה (ללא גוף תשובה).
          console.warn(
            '[Leads Sync] כשל בשליחת',
            maskPhone(lead.phone),
            e && e.message ? e.message : e
          );
        }
        await sleep(randDelay());
      }

      alert(
        'הסנכרון הסתיים.\n' +
          'נשלחו: ' +
          okCount +
          (failCount ? '\nנכשלו: ' + failCount : '') +
          '\n(ה-CRM מאחד כפילויות לפי טלפון.)'
      );
    } catch (e) {
      console.error('[Leads Sync] שגיאה:', e);
      alert('שגיאה: ' + (e && e.message ? e.message : e));
    } finally {
      isSyncing = false;
      setBtnState('idle', 'סנכרן לידים');
    }
  }

  // ─────────────────────────── כפתור צף (RTL) ────────────────────────────
  let btnEl = null;

  function injectButton() {
    if (btnEl) return;
    btnEl = document.createElement('button');
    btnEl.textContent = 'סנכרן לידים';
    btnEl.setAttribute('dir', 'rtl');
    Object.assign(btnEl.style, {
      position: 'fixed',
      bottom: '24px',
      insetInlineStart: '24px', // RTL: צמוד לפינה התחתונה (צד התחלה)
      zIndex: '99999',
      padding: '10px 18px',
      background: '#075E54',
      color: '#fff',
      border: 'none',
      borderRadius: '24px',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: 'inherit',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      direction: 'rtl',
    });
    btnEl.addEventListener('click', syncLeads);
    document.body.appendChild(btnEl);
  }

  function setBtnState(state, text) {
    if (!btnEl) return;
    btnEl.textContent = text;
    btnEl.disabled = state === 'busy';
    btnEl.style.opacity = state === 'busy' ? '0.6' : '1';
    btnEl.style.cursor = state === 'busy' ? 'default' : 'pointer';
  }

  // ──────────────────────────────── אתחול ────────────────────────────────
  function init() {
    if (document.body) injectButton();
    else window.addEventListener('DOMContentLoaded', injectButton);
  }

  init();
})();
