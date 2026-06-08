// ==UserScript==
// @name         WhatsApp Leads Sync → Base44
// @namespace    https://github.com/strugo7/whatsapp-leads-sync
// @version      1.4.0
// @description  קורא לידים מתויגים ב-WhatsApp Web (READ-ONLY) ושולח אותם ל-CRM ב-Base44. סנכרון בלחיצה בלבד.
// @author       strugo7
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/@wppconnect/wa-js@4.3.0/dist/wppconnect-wa.js
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

  // לוג טעינה — אם השורה הזו לא מופיעה בקונסול, הסקריפט עצמו לא רץ (בד"כ @require נכשל).
  console.log('%c[Leads Sync] v1.4.0 נטען', 'color:#00a884;font-weight:bold');

  // ───────────────────────────── מפתחות אחסון ─────────────────────────────
  const STORE = {
    WEBHOOK_URL: 'cfg_webhook_url',
    SHARED_SECRET: 'cfg_shared_secret',
    LABEL_NAME: 'cfg_label_name', // ישן — נשמר לקריאת מיגרציה בלבד
    LABELS: 'cfg_labels', // JSON של מערך [{id, name}] — בחירת תגיות מרובה
    DRY_RUN: 'cfg_dry_run',
  };

  // כל מפתחות האחסון המקומיים — לשימוש כפתור "מחק נתונים מקומיים".
  const ALL_STORE_KEYS = Object.values(STORE);

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
    // התגיות שנבחרו לסנכרון — מערך של {id, name}. עם מיגרציה מהמפתח הישן (תגית בודדת).
    get selectedLabels() {
      try {
        const raw = GM_getValue(STORE.LABELS, '');
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) return arr.filter((x) => x && x.name);
        }
      } catch (e) {
        /* נופל למיגרציה */
      }
      // מיגרציה: אם קיים שם תגית ישן בודד — להמיר לרשימה.
      const legacy = (GM_getValue(STORE.LABEL_NAME, '') || '').trim();
      return legacy ? [{ id: null, name: legacy }] : [];
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
  // הכל זמין דרך הפאנל ה-GUI; התפריט משמש כקיצור/גיבוי.
  GM_registerMenuCommand('פתח ממשק סנכרון לידים', () => ui.open());
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

      // 4) כמה צ'אטים מזוהים תחת כל אחת מהתגיות הנבחרות (אימות הצינור מקצה לקצה)
      const selected = cfg.selectedLabels;
      if (selected.length === 0) {
        console.warn('לא נבחרו תגיות בהגדרות.');
      } else {
        for (const sel of selected) {
          const label = labels.find(
            (l) =>
              (sel.id != null && String(l.id) === String(sel.id)) ||
              String(l.name).trim() === String(sel.name).trim()
          );
          if (!label) {
            console.warn('לא נמצאה תגית:', sel.name);
            continue;
          }
          const count = chats.filter((c) => chatHasLabel(c, String(label.id))).length;
          console.log('צ\'אטים תחת התגית "' + label.name + '":', count);
        }
      }
      const okMsg = 'בדיקת Step 0 הסתיימה — פרטים מלאים ב-Console (F12).';
      if (ui.built) ui.status(okMsg, 'success');
      else alert(okMsg);
    } catch (e) {
      console.error('[Leads Sync] שגיאה בבדיקה:', e);
      const errMsg = 'שגיאה בבדיקה: ' + (e && e.message ? e.message : e);
      if (ui.built) ui.status(errMsg, 'error');
      else alert(errMsg);
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
    if (ui.built) {
      ui.refresh();
      ui.status('כל הנתונים המקומיים נמחקו. הזן הגדרות מחדש.', 'success');
    } else {
      alert('כל הנתונים המקומיים נמחקו.');
    }
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
  // מחזיר מערך של { phone, name, wid, labels } עבור הצ'אטים שתחת התגיות הנבחרות.
  // labelsOverride (אופציונלי) — מערך [{id,name}] לתצוגה מקדימה לפני שמירה; ברירת מחדל cfg.selectedLabels.
  async function collectLeads(WPP, labelsOverride) {
    const selected = labelsOverride || cfg.selectedLabels;
    if (!selected || selected.length === 0) {
      throw new Error('לא נבחרו תגיות. פתח "הגדרות" וסמן לפחות תגית אחת.');
    }

    // 1) שולפים את כל התגיות הקיימות ובונים מפה id→name.
    const allLabels = (await WPP.labels.getAllLabels()) || [];
    const idToName = new Map();
    const nameToId = new Map();
    for (const l of allLabels) {
      idToName.set(String(l.id), String(l.name));
      nameToId.set(String(l.name).trim(), String(l.id));
    }

    // פותרים את ה-ids הנבחרים: מעדיפים id קיים, אחרת מתאימים לפי שם (מיגרציה).
    const selectedIds = new Set();
    for (const sel of selected) {
      const byId = sel.id != null && idToName.has(String(sel.id)) ? String(sel.id) : null;
      const byName = !byId && sel.name ? nameToId.get(String(sel.name).trim()) : null;
      if (byId) selectedIds.add(byId);
      else if (byName) selectedIds.add(byName);
    }
    if (selectedIds.size === 0) {
      throw new Error('התגיות שנבחרו לא נמצאו בחשבון. פתח "הגדרות" ובחר מחדש.');
    }

    // 2) שולפים את כל הצ'אטים ומסננים לפי חברות באחת מהתגיות הנבחרות (READ).
    const chats = await WPP.chat.list();

    const byPhone = new Map(); // dedup: צ'אט תחת כמה תגיות נבחרות → ליד אחד.
    for (const chat of chats || []) {
      const matchedIds = [...selectedIds].filter((id) => chatHasLabel(chat, id));
      if (matchedIds.length === 0) continue;

      // טלפון מה-WID: כבר בפורמט בינלאומי קנוני (למשל 972501234567@c.us).
      // מוסיפים + בלבד — בלי נירמול ידני.
      const wid = chat.id;
      const user = wid && wid.user ? String(wid.user) : '';
      if (!user) continue;

      // מדלגים על קבוצות (WID של קבוצה אינו טלפון של ליד).
      const server = wid && wid.server ? String(wid.server) : '';
      if (server === 'g.us') continue;

      const phone = '+' + user;
      const matchedNames = matchedIds.map((id) => idToName.get(id)).filter(Boolean);
      if (byPhone.has(phone)) {
        // צ'אט/טלפון שכבר נראה — מאחדים את שמות התגיות.
        const existing = byPhone.get(phone);
        for (const n of matchedNames) {
          if (!existing.labels.includes(n)) existing.labels.push(n);
        }
      } else {
        byPhone.set(phone, {
          phone,
          wid: user + '@' + (server || 'c.us'),
          name: chat.name || chat.formattedTitle || '',
          labels: matchedNames,
        });
      }
    }

    return [...byPhone.values()];
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
      labels: lead.labels || [], // שמות התגיות שמהן הגיע הליד
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
    ui.open();
    ui.setBusy(true);
    ui.clearResults();

    try {
      if (!cfg.dryRun && !cfg.isConfigured()) {
        ui.status('חסרות הגדרות. פתח "הגדרות" והזן כתובת Webhook + סוד.', 'error');
        ui.showSettings(true);
        return;
      }
      if (cfg.selectedLabels.length === 0) {
        ui.status('לא נבחרו תגיות. פתח "הגדרות" וסמן לפחות תגית אחת.', 'error');
        ui.showSettings(true);
        return;
      }

      ui.status('טוען את WhatsApp…', 'info');
      const WPP = await waitForWPP();
      ui.status('קורא לידים מהתגיות…', 'info');
      const leads = await collectLeads(WPP);

      // אין dedup מקומי — לא שומרים כלום על המכשיר. ה-dedup הסופי הוא ה-upsert
      // בשרת (לפי טלפון), כך שאפשר לשלוח את אותו ליד שוב בלי ליצור כפילות.
      if (leads.length === 0) {
        ui.status('לא נמצאו צ\'אטים תחת התגיות שנבחרו.', 'warn');
        return;
      }

      // טלפונים ממוסכים בלבד לתצוגה (קונסול + פאנל).
      const masked = leads.map((l) => ({ phone: maskPhone(l.phone), name: l.name }));

      // ── DRY_RUN: רק מציגים, לא שולחים כלום ──
      if (cfg.dryRun) {
        console.log('%c[Leads Sync] DRY_RUN — לא נשלח כלום.', 'font-weight:bold');
        console.table(masked);
        ui.showLeadsTable(masked);
        ui.status(
          'DRY_RUN: נמצאו ' + leads.length + ' לידים. לא נשלח כלום (טלפונים ממוסכים).',
          'success'
        );
        return;
      }

      // ── שליחה אמיתית, אחד-אחד עם השהיה אנושית. השרת עושה upsert לפי טלפון. ──
      let okCount = 0;
      let failCount = 0;
      for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        ui.status('שולח ' + (i + 1) + ' מתוך ' + leads.length + '…', 'info');
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

      ui.showLeadsTable(masked);
      ui.status(
        'הסתיים. נשלחו: ' + okCount +
          (failCount ? ' · נכשלו: ' + failCount : '') +
          ' (ה-CRM מאחד לפי טלפון).',
        failCount ? 'warn' : 'success'
      );
    } catch (e) {
      console.error('[Leads Sync] שגיאה:', e);
      ui.status('שגיאה: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      isSyncing = false;
      ui.setBusy(false);
    }
  }

  // ───────────────────────────── ממשק (GUI) ──────────────────────────────
  // פאנל צף משלנו בתוך Shadow DOM — מבודד לחלוטין מה-CSS של WhatsApp, RTL מלא,
  // ולא נוגע ב-DOM של WhatsApp (יציב לאורך זמן, משטח זיהוי מינימלי).
  const WA_GREEN = '#00a884';
  const WA_DARK = '#075E54';

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .launcher {
      position: fixed; bottom: 22px; inset-inline-start: 22px; z-index: 2147483646;
      width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
      background: ${WA_GREEN}; color: #fff; font-size: 24px; line-height: 1;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); transition: transform .12s ease;
    }
    .launcher:hover { transform: scale(1.06); }
    .panel {
      position: fixed; bottom: 90px; inset-inline-start: 22px; z-index: 2147483647;
      width: 320px; max-height: 78vh; overflow-y: auto; direction: rtl;
      background: #fff; color: #111b21; border-radius: 14px;
      box-shadow: 0 10px 40px rgba(0,0,0,.32); border: 1px solid #e9edef;
    }
    .panel[hidden] { display: none; }
    .hdr {
      display: flex; align-items: center; justify-content: space-between;
      background: ${WA_DARK}; color: #fff; padding: 12px 14px;
      border-radius: 14px 14px 0 0;
    }
    .hdr .title { font-weight: 700; font-size: 15px; }
    .hdr .x { background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; padding: 2px 6px; }
    .body { padding: 14px; }
    .badges { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .badge { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 20px; }
    .badge.ok { background: #d9fdd3; color: #0a6b2e; }
    .badge.warn { background: #fff3cd; color: #8a6100; }
    .badge.err { background: #fde2e1; color: #b02a24; }
    button.primary {
      width: 100%; padding: 11px; border: none; border-radius: 10px; cursor: pointer;
      background: ${WA_GREEN}; color: #fff; font-size: 15px; font-weight: 700;
    }
    button.primary:disabled { opacity: .55; cursor: default; }
    .toggle { display: flex; align-items: center; gap: 8px; margin: 12px 0; font-size: 14px; cursor: pointer; }
    .actions { display: flex; gap: 8px; margin-top: 4px; }
    button.ghost {
      flex: 1; padding: 8px; border: 1px solid #d1d7db; border-radius: 8px; cursor: pointer;
      background: #f7f8fa; color: #111b21; font-size: 13px; font-weight: 600;
    }
    .settings { margin-top: 12px; border-top: 1px solid #eef1f3; padding-top: 12px; }
    .settings[hidden] { display: none; }
    .settings label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 10px; color: #54656f; }
    .settings input {
      width: 100%; margin-top: 4px; padding: 8px; border: 1px solid #d1d7db;
      border-radius: 8px; font-size: 13px; direction: ltr; text-align: start;
    }
    .settings-actions { display: flex; gap: 8px; }
    button.small { padding: 8px; font-size: 13px; }
    .lbl-head { display: flex; align-items: center; justify-content: space-between; }
    .lbl-head .link { background: none; border: none; color: ${WA_GREEN}; cursor: pointer; font-size: 12px; font-weight: 600; padding: 0; }
    .lbl-list { max-height: 160px; overflow-y: auto; border: 1px solid #d1d7db; border-radius: 8px; padding: 6px 8px; margin-top: 4px; }
    .lbl-row { display: flex; align-items: center; gap: 8px; padding: 5px 2px; font-weight: 500; color: #111b21; cursor: pointer; }
    .lbl-row input { width: auto; margin: 0; }
    .lbl-dot { width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto; border: 1px solid rgba(0,0,0,.15); }
    .lbl-muted { color: #8696a0; font-size: 12px; padding: 6px 2px; }
    .lbl-count { font-size: 12px; color: #54656f; margin-top: 6px; font-weight: 600; }
    button.ghost.preview { margin-top: 8px; }
    button.danger { border: 1px solid #f1b0ad; background: #fff; color: #b02a24; border-radius: 8px; cursor: pointer; font-weight: 600; flex: 1; }
    .status { margin-top: 12px; font-size: 13px; min-height: 18px; line-height: 1.4; }
    .status.info { color: #54656f; }
    .status.success { color: #0a6b2e; }
    .status.warn { color: #8a6100; }
    .status.error { color: #b02a24; }
    .results { margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: start; padding: 6px 8px; border-bottom: 1px solid #eef1f3; }
    th { color: #54656f; font-weight: 700; }
    td.ph { direction: ltr; text-align: start; font-variant-numeric: tabular-nums; }
    .foot { margin-top: 12px; font-size: 11px; color: #8696a0; text-align: center; }
  `;

  const UI_HTML = `
    <button class="launcher" id="wals-launch" title="סנכרון לידים" aria-label="סנכרון לידים">↗</button>
    <div class="panel" id="wals-panel" hidden>
      <div class="hdr">
        <span class="title">סנכרון לידים</span>
        <button class="x" id="wals-close" title="סגור" aria-label="סגור">✕</button>
      </div>
      <div class="body">
        <div class="badges">
          <span class="badge" id="wals-conn"></span>
          <span class="badge" id="wals-mode"></span>
        </div>
        <button class="primary" id="wals-sync">סנכרן לידים</button>
        <label class="toggle"><input type="checkbox" id="wals-dry"> מצב DRY_RUN (לא שולח, רק מציג)</label>
        <div class="actions">
          <button class="ghost" id="wals-step0">בדיקת תגיות</button>
          <button class="ghost" id="wals-settings-btn">הגדרות</button>
        </div>
        <div class="settings" id="wals-settings" hidden>
          <label>כתובת Webhook (HTTPS)
            <input type="url" id="wals-url" placeholder="https://...base44.app/...">
          </label>
          <label>סוד משותף (לחתימת HMAC)
            <input type="password" id="wals-secret" placeholder="••••••••">
          </label>
          <div class="lbl-head">
            <label style="margin-bottom:4px">תגיות לסנכרון (בחירה מרובה)</label>
            <button class="link" id="wals-labels-reload">רענן</button>
          </div>
          <div class="lbl-list" id="wals-labels"><div class="lbl-muted">פתח כדי לטעון תגיות…</div></div>
          <div class="lbl-count" id="wals-labels-count"></div>
          <button class="ghost preview" id="wals-preview">תצוגה מקדימה</button>
          <div class="settings-actions" style="margin-top:10px">
            <button class="primary small" id="wals-save">שמור</button>
            <button class="danger small" id="wals-clear">מחק נתונים</button>
          </div>
        </div>
        <div class="status info" id="wals-status"></div>
        <div class="results" id="wals-results"></div>
        <div class="foot">READ-ONLY · סנכרון בלחיצה בלבד</div>
      </div>
    </div>
  `;

  const ui = {
    built: false,
    root: null,
    refs: {},

    build() {
      if (this.built) return;
      const host = document.createElement('div');
      host.id = 'wals-host';
      document.body.appendChild(host);
      this.root = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = UI_CSS;
      this.root.appendChild(style);

      const wrap = document.createElement('div');
      wrap.dir = 'rtl';
      wrap.innerHTML = UI_HTML;
      this.root.appendChild(wrap);

      const $ = (id) => this.root.getElementById(id);
      this.refs = {
        launch: $('wals-launch'), panel: $('wals-panel'), close: $('wals-close'),
        conn: $('wals-conn'), mode: $('wals-mode'), sync: $('wals-sync'),
        dry: $('wals-dry'), step0: $('wals-step0'), settingsBtn: $('wals-settings-btn'),
        settings: $('wals-settings'), url: $('wals-url'), secret: $('wals-secret'),
        labels: $('wals-labels'), labelsCount: $('wals-labels-count'),
        labelsReload: $('wals-labels-reload'), preview: $('wals-preview'),
        save: $('wals-save'), clear: $('wals-clear'),
        status: $('wals-status'), results: $('wals-results'),
      };

      const r = this.refs;
      r.launch.addEventListener('click', () => this.toggle());
      r.close.addEventListener('click', () => this.close());
      r.sync.addEventListener('click', syncLeads);
      r.step0.addEventListener('click', runLabelDiagnostics);
      r.settingsBtn.addEventListener('click', () => this.showSettings());
      r.labelsReload.addEventListener('click', () => this.loadLabels(true));
      r.preview.addEventListener('click', () => this.previewLeads());
      r.save.addEventListener('click', () => this.saveSettings());
      r.clear.addEventListener('click', clearLocalData);
      r.dry.addEventListener('change', () => {
        GM_setValue(STORE.DRY_RUN, r.dry.checked);
        this.refresh();
        this.status(r.dry.checked ? 'מצב DRY_RUN פעיל — לא יישלח כלום.' : 'מצב שליחה אמיתית פעיל.', 'info');
      });

      this.built = true;
      this.refresh();
    },

    open() { this.build(); this.refs.panel.hidden = false; this.refresh(); },
    close() { if (this.built) this.refs.panel.hidden = true; },
    toggle() { this.build(); this.refs.panel.hidden = !this.refs.panel.hidden; if (!this.refs.panel.hidden) this.refresh(); },

    showSettings(force) {
      if (!this.built) return;
      const s = this.refs.settings;
      s.hidden = force === true ? false : !s.hidden;
      if (!s.hidden) this.loadLabels(); // טוען תגיות כשנפתח (אם עוד לא נטענו)
    },

    // טוען את התגיות מחשבון ה-WhatsApp ומציג כצ'קבוקסים. force=true → טעינה מחדש.
    async loadLabels(force) {
      if (!this.built) return;
      if (this._labelsLoaded && !force) return;
      const box = this.refs.labels;
      box.innerHTML = '<div class="lbl-muted">טוען תגיות…</div>';
      try {
        const WPP = await waitForWPP();
        const labels = (await WPP.labels.getAllLabels()) || [];
        if (labels.length === 0) {
          box.innerHTML = '<div class="lbl-muted">לא נמצאו תגיות בחשבון.</div>';
          this._labelsLoaded = true;
          return;
        }
        // אילו מסומנות לפי מה ששמור (התאמה לפי id או שם).
        const selected = cfg.selectedLabels;
        const isSel = (l) =>
          selected.some(
            (s) =>
              (s.id != null && String(s.id) === String(l.id)) ||
              (s.name && String(s.name).trim() === String(l.name).trim())
          );
        box.innerHTML = labels
          .map((l) => {
            const color = labelColor(l);
            const dot = color
              ? '<span class="lbl-dot" style="background:' + color + '"></span>'
              : '<span class="lbl-dot" style="background:#ccc"></span>';
            return (
              '<label class="lbl-row">' +
              '<input type="checkbox" data-id="' + escapeHtml(l.id) +
              '" data-name="' + escapeHtml(l.name) + '"' + (isSel(l) ? ' checked' : '') + '>' +
              dot +
              '<span>' + escapeHtml(l.name) + '</span>' +
              '</label>'
            );
          })
          .join('');
        box.querySelectorAll('input[type=checkbox]').forEach((cb) =>
          cb.addEventListener('change', () => this.updateLabelsCount())
        );
        this._labelsLoaded = true;
        this.updateLabelsCount();
      } catch (e) {
        box.innerHTML =
          '<div class="lbl-muted">לא ניתן לטעון תגיות — ודא ש-WhatsApp נטען, ולחץ "רענן".</div>';
        console.warn('[Leads Sync] loadLabels:', e);
      }
    },

    getCheckedLabels() {
      if (!this.built) return [];
      return [...this.refs.labels.querySelectorAll('input[type=checkbox]:checked')].map((cb) => ({
        id: cb.getAttribute('data-id') || null,
        name: cb.getAttribute('data-name') || '',
      }));
    },

    updateLabelsCount() {
      if (!this.built) return;
      const n = this.getCheckedLabels().length;
      this.refs.labelsCount.textContent = n ? 'נבחרו ' + n + ' תגיות' : 'לא נבחרו תגיות';
    },

    async previewLeads() {
      const checked = this.getCheckedLabels();
      if (checked.length === 0) {
        this.status('סמן לפחות תגית אחת לתצוגה מקדימה.', 'warn');
        return;
      }
      this.clearResults();
      this.status('טוען תצוגה מקדימה…', 'info');
      try {
        const WPP = await waitForWPP();
        const leads = await collectLeads(WPP, checked);
        if (leads.length === 0) {
          this.status('אין צ\'אטים תחת התגיות שנבחרו.', 'warn');
          return;
        }
        this.showLeadsTable(leads.map((l) => ({ phone: maskPhone(l.phone), name: l.name })));
        this.status('תצוגה מקדימה: ' + leads.length + ' לידים (טלפונים ממוסכים).', 'success');
      } catch (e) {
        this.status('שגיאה בתצוגה מקדימה: ' + (e && e.message ? e.message : e), 'error');
      }
    },

    setBusy(busy) {
      if (!this.built) return;
      this.refs.sync.disabled = busy;
      this.refs.sync.textContent = busy ? 'מסנכרן…' : 'סנכרן לידים';
    },

    status(text, type) {
      if (!this.built) return;
      this.refs.status.className = 'status ' + (type || 'info');
      this.refs.status.textContent = text || '';
    },

    clearResults() { if (this.built) this.refs.results.innerHTML = ''; },

    showLeadsTable(rows) {
      if (!this.built) return;
      const body = rows
        .map(
          (x) =>
            '<tr><td class="ph">' + escapeHtml(x.phone) + '</td><td>' + escapeHtml(x.name) + '</td></tr>'
        )
        .join('');
      this.refs.results.innerHTML =
        '<table><thead><tr><th>טלפון (ממוסך)</th><th>שם</th></tr></thead><tbody>' +
        body +
        '</tbody></table>';
    },

    saveSettings() {
      const r = this.refs;
      GM_setValue(STORE.WEBHOOK_URL, r.url.value.trim());
      GM_setValue(STORE.SHARED_SECRET, r.secret.value.trim());
      GM_setValue(STORE.LABELS, JSON.stringify(this.getCheckedLabels()));
      this.refresh();
      this.status('ההגדרות נשמרו.', 'success');
    },

    refresh() {
      if (!this.built) return;
      const r = this.refs;
      r.url.value = cfg.webhookUrl;
      r.secret.value = cfg.sharedSecret;
      r.dry.checked = cfg.dryRun;
      const configured = cfg.isConfigured();
      r.conn.textContent = configured ? 'מחובר ל-CRM' : 'לא מוגדר';
      r.conn.className = 'badge ' + (configured ? 'ok' : 'err');
      r.mode.textContent = cfg.dryRun ? 'DRY_RUN' : 'שליחה אמיתית';
      r.mode.className = 'badge ' + (cfg.dryRun ? 'warn' : 'ok');
      if (this._labelsLoaded) this.updateLabelsCount();
    },
  };

  // צבע התגית מ-wa-js עשוי להגיע כ-hex ('#abc...') או כמספר ARGB/RGB. מחזיר CSS color או null.
  function labelColor(l) {
    const c = l && (l.color != null ? l.color : l.colorHex);
    if (c == null) return null;
    if (typeof c === 'string') return c.startsWith('#') ? c : '#' + c;
    if (typeof c === 'number') {
      // מספר → hex של 6 ספרות (מתעלמים מ-alpha אם קיים).
      const hex = (c >>> 0).toString(16).padStart(8, '0').slice(-6);
      return '#' + hex;
    }
    return null;
  }

  // הימלטות בסיסית למניעת HTML injection בתצוגת השם/טלפון בפאנל.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ──────────────────────────────── אתחול ────────────────────────────────
  function init() {
    try {
      if (document.body) ui.build();
      else window.addEventListener('DOMContentLoaded', () => ui.build());
      console.log('%c[Leads Sync] הממשק אותחל — חפש כפתור צף בפינה התחתונה',
        'color:#00a884');
    } catch (e) {
      console.error('[Leads Sync] כשל באתחול הממשק:', e);
    }
  }

  init();
})();
