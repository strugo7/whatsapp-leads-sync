// ==UserScript==
// @name         WhatsApp Leads Sync → Base44
// @namespace    https://github.com/strugo7/whatsapp-leads-sync
// @version      1.6.1
// @description  קורא לידים מתויגים ב-WhatsApp Web (READ-ONLY) ושולח אותם ל-CRM ב-Base44. סנכרון בלחיצה בלבד.
// @author       strugo7
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
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
 *    • אין סודות בקוד — WEBHOOK_URL / SHARED_SECRET / תגיות נשמרים מקומית
 *      ב-localStorage דרך טופס ההגדרות בפאנל. לכן מותר לפרסם ציבורית.
 *
 *  ארכיטקטורה: רץ עם @grant GM_xmlhttpRequest כדי לעקוף CSP של WhatsApp Web
 *  (שחוסם fetch לדומיינים חיצוניים כמו base44.app). חובה ש-@connect יכיל את
 *  הדומיין (host) בלבד — לא URL מלא — אחרת Tampermonkey יחסום את הבקשה. הקריאה מ-IndexedDB
 *  עובדת גם ב-sandbox (אותו origin). האחסון ב-localStorage.
 *
 *  לפני שימוש ראשון: ראה "Step 0" ב-README — בדיקה שמאמתת איפה wa-js
 *  מחזיק את תגיות הצ'אט בגרסה הספציפית שלך.
 * ──────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // לוג טעינה — אם השורה הזו לא מופיעה בקונסול, הסקריפט עצמו לא רץ (בד"כ @require נכשל).
  console.log('%c[Leads Sync] v1.6.1 נטען', 'color:#00a884;font-weight:bold');

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

  // ───────────────────────── אחסון מקומי (localStorage) ───────────────────
  // תחת @grant none אין GM storage, לכן שומרים ב-localStorage. המפתחות מקבלים
  // prefix כדי לא להתנגש עם WhatsApp, והערכים נשמרים כ-JSON.
  const LS_PREFIX = 'wals_';
  const store = {
    get(key, def) {
      try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw === null ? def : JSON.parse(raw);
      } catch (e) {
        return def;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(val));
      } catch (e) {
        /* מתעלמים — אחסון חסום */
      }
    },
    del(key) {
      try {
        localStorage.removeItem(LS_PREFIX + key);
      } catch (e) {
        /* מתעלמים */
      }
    },
  };

  // ───────────────────────────── עזרי config ─────────────────────────────
  const cfg = {
    get webhookUrl() {
      return String(store.get(STORE.WEBHOOK_URL, '') || '').trim();
    },
    get sharedSecret() {
      return String(store.get(STORE.SHARED_SECRET, '') || '').trim();
    },
    // התגיות שנבחרו לסנכרון — מערך של {id, name}. עם מיגרציה מהמפתח הישן (תגית בודדת).
    get selectedLabels() {
      const arr = store.get(STORE.LABELS, null);
      if (Array.isArray(arr)) return arr.filter((x) => x && x.name);
      // מיגרציה: אם קיים שם תגית ישן בודד — להמיר לרשימה.
      const legacy = String(store.get(STORE.LABEL_NAME, '') || '').trim();
      return legacy ? [{ id: null, name: legacy }] : [];
    },
    // DRY_RUN ברירת מחדל: true (לא שולח כלום, רק מדפיס).
    get dryRun() {
      const v = store.get(STORE.DRY_RUN, true);
      return v === undefined ? true : Boolean(v);
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

  // הערה: תחת @grant none אין GM_registerMenuCommand — כל הפעולות זמינות דרך
  // הפאנל ה-GUI (כפתור צף → סנכרון / בדיקת תגיות / הגדרות / מחיקת נתונים).

  // Step 0 — בדיקת מבנה התגיות. מדפיס לקונסול את התגיות ומבנה הצ'אט מתוך IndexedDB.
  async function runLabelDiagnostics() {
    try {
      console.log('%c[Leads Sync] Step 0 — בדיקת תגיות (IndexedDB)', 'font-weight:bold;font-size:14px');
      const db = await openWaModelDb();
      console.log('Stores זמינים:', [...db.objectStoreNames]);
      
      const allLabels = await readIdbLabels(db);
      console.table(allLabels.map((l) => ({ id: l.id, name: l.name })));

      const nameById = new Map(allLabels.map((l) => [l.id, l.name]));
      const selected = cfg.selectedLabels;
      if (selected.length === 0) {
        console.warn('לא נבחרו תגיות בהגדרות.');
      } else {
        const labelIds = selected.map(s => String(s.id));
        const leads = await collectLabeledLeads(db, labelIds, nameById);
        console.log('נמצאו ' + leads.length + ' לידים תחת התגיות הנבחרות.');
        if (leads.length > 0) {
           console.log('דוגמה לליד ראשון:', { ...leads[0], phone: maskPhone(leads[0].phone) });
        }
      }
      db.close();
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
    for (const key of ALL_STORE_KEYS) store.del(key);
    if (ui.built) {
      ui.refresh();
      ui.status('כל הנתונים המקומיים נמחקו. הזן הגדרות מחדש.', 'success');
    } else {
      alert('כל הנתונים המקומיים נמחקו.');
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───────────── ייצוא אנשי קשר ל-CSV (מקור: IndexedDB, ללא wa-js) ─────────
  // wa-js תלוי ב-isReady; כשהוא לא מגיע ל-ready (חוסר תאימות גרסה) אין דרך לקרוא
  // אנשי קשר דרכו. כאן קוראים ישירות מ-IndexedDB של WhatsApp — READ-ONLY מוחלט:
  // פותחים בלי version (לא יוצרים/משדרגים), transaction של readonly בלבד, וסוגרים.
  // חריגה מודעת מאינווריאנט "אין טלפונים מקומית": ה-CSV המורד מכיל טלפונים מלאים
  // (ביוזמת המשתמש). הקונסול והפאנל נשארים ממוסכים. ראה CLAUDE.md.

  function openIdb(name) {
    return new Promise((resolve, reject) => {
      // ללא version → פותחים DB קיים בלבד; לא יוצרים ולא משדרגים (שומר READ-ONLY).
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('open failed'));
      req.onblocked = () => reject(new Error('open blocked'));
      // אם ה-DB לא קיים, open ינסה ליצור (version 1) → מבטלים כדי לא לכתוב כלום.
      req.onupgradeneeded = () => {
        try { req.transaction.abort(); } catch (e) { }
        reject(new Error('db missing'));
      };
    });
  }

  // קורא {key, value} עבור כל הרשומות ב-store (cursor — כי לפעמים ה-id קיים רק במפתח).
  function idbReadAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(out); return; }
        out.push({ key: cur.key, value: cur.value });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  const firstNonEmpty = (...vals) => {
    for (const v of vals) {
      const s = v == null ? '' : String(v).trim();
      if (s) return s;
    }
    return '';
  };

  // get בודד לפי מפתח (READ-ONLY). מחזיר value או null, בלי לזרוק.
  function idbGet(db, storeName, key) {
    return new Promise((resolve) => {
      try {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  // טלפון מתוך jid כמו "972546533801@c.us" או כמספר טהור → "+972546533801". @lid/@g.us/אחר → null.
  // (וואטסאפ עברו ל-LID: רשומת contact ממופתחת ב-@lid, והטלפון בשדה phoneNumber)
  function waPhoneFromJid(jid) {
    const s = String(jid || '');
    if (s.endsWith('@lid') || s.endsWith('@g.us')) return null;
    const m = /^\+?(\d{5,})(?:@(?:c\.us|s\.whatsapp\.net))?$/.exec(s);
    return m ? '+' + m[1] : null;
  }

  // מאתר ופותח את ה-DB של WhatsApp שמכיל את ה-stores contact + label (בד"כ "model-storage").
  async function openWaModelDb() {
    if (typeof indexedDB.databases !== 'function') {
      throw new Error('indexedDB.databases() לא נתמך בדפדפן הזה — נסה Chrome עדכני.');
    }
    const names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean);
    // עדיפות ל-model-storage, אבל מאמתים לפי תוכן (קיום contact + label).
    names.sort((a, b) => (/model-storage/i.test(b) ? 1 : 0) - (/model-storage/i.test(a) ? 1 : 0));
    for (const name of names) {
      let db;
      try { db = await openIdb(name); } catch (e) { continue; }
      const stores = [...db.objectStoreNames];
      const hasContact = stores.includes('contact');
      const hasLabel = stores.includes('label') || stores.includes('labels');
      if (hasContact && hasLabel) return db;
      try { db.close(); } catch (e) { }
    }
    throw new Error('לא נמצא ה-IndexedDB של WhatsApp (contact + label). ודא ש-WhatsApp Web פתוח ומחובר.');
  }

  // קורא את ה-store "label" (או "labels") → [{ id, name, color }].
  async function readIdbLabels(db) {
    const storeName = [...db.objectStoreNames].includes('label') ? 'label' : 'labels';
    const recs = await idbReadAll(db, storeName);
    return recs.map(({ key, value }) => {
      const v = value || {};
      const id = String(v.id != null ? v.id : key);
      return {
        id,
        name: firstNonEmpty(v.name, v.labelName, v.text) || ('תגית ' + id),
        color: v.color != null ? v.color : v.colorHex,
      };
    });
  }

  // אוסף לידים תחת התגיות הנבחרות: label-association → associationId → contact.phoneNumber.
  // מדלג על קבוצות (@g.us). מאחד לפי jid וצובר את שמות התגיות התואמות.
  async function collectLabeledLeads(db, labelIds, nameById) {
    const want = new Set(labelIds.map(String));
    const stores = [...db.objectStoreNames];
    const assocStore = stores.includes('label-association') ? 'label-association' : (stores.includes('labels-association') ? 'labels-association' : null);
    if (!assocStore) return [];
    const assocs = await idbReadAll(db, assocStore);
    const byJid = new Map(); // jid → Set(שמות תגיות)
    for (const { value } of assocs) {
      const v = value || {};
      if (!want.has(String(v.labelId))) continue;
      if (v.type && v.type !== 'jid') continue; // רק שיוך של צ'אט/איש קשר
      const jid = v.associationId;
      if (!jid || /@g\.us$/.test(jid)) continue; // קבוצות אינן לידים
      if (!byJid.has(jid)) byJid.set(jid, new Set());
      byJid.get(jid).add(nameById.get(String(v.labelId)) || String(v.labelId));
    }
    const rows = [];
    for (const [jid, labelSet] of byJid) {
      const c = (await idbGet(db, 'contact', jid)) || {};
      const phone = waPhoneFromJid(c.phoneNumber) || waPhoneFromJid(jid) || '';
      const name = firstNonEmpty(
        c.name, c.formattedName, c.pushname, c.notifyName, c.shortName, c.verifiedName
      );
      rows.push({ phone, name, labels: [...labelSet].join(' | '), raw_id: jid });
    }
    return rows;
  }

  // בונה מחרוזת CSV. BOM של UTF-8 כדי ששמות בעברית ייפתחו נכון באקסל; שורות CRLF.
  function csvEscape(val) {
    const s = String(val == null ? '' : val);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function buildCsv(headers, rows) {
    const BOM = '\uFEFF'; // U+FEFF — כדי ששמות בעברית ייפתחו נכון באקסל
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    return BOM + lines.join('\r\n') + '\r\n';
  }

  // הורדת קובץ מקומי דרך Blob — עובד תחת @grant none (אין צורך ב-GM_download).
  function downloadCsv(filename, csvText) {
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const randDelay = () =>
    SEND_DELAY_MIN_MS +
    Math.floor(Math.random() * (SEND_DELAY_MAX_MS - SEND_DELAY_MIN_MS + 1));

  // ──────────────────────── שליפת לידים (READ-ONLY) ───────────────────────
  // מחזיר מערך של { phone, name, wid, labels } עבור הצ'אטים שתחת התגיות הנבחרות.
  // labelsOverride (אופציונלי) — מערך [{id,name}] לתצוגה מקדימה לפני שמירה; ברירת מחדל cfg.selectedLabels.
  async function collectLeads(labelsOverride) {
    const selected = labelsOverride || cfg.selectedLabels;
    if (!selected || selected.length === 0) {
      throw new Error('לא נבחרו תגיות. פתח "הגדרות" וסמן לפחות תגית אחת.');
    }

    let db;
    try {
      db = await openWaModelDb();
      const allLabels = await readIdbLabels(db);
      const nameById = new Map(allLabels.map((l) => [l.id, l.name]));

      const labelIds = [];
      for (const sel of selected) {
        if (sel.id != null) {
          labelIds.push(String(sel.id));
        } else if (sel.name) {
          const found = allLabels.find((l) => String(l.name).trim() === String(sel.name).trim());
          if (found) labelIds.push(String(found.id));
        }
      }

      if (labelIds.length === 0) throw new Error('התגיות שנבחרו לא נמצאו (IDB).');

      const rows = await collectLabeledLeads(db, labelIds, nameById);
      return rows.filter((r) => r.phone).map((r) => ({
        phone: r.phone,
        wid: r.raw_id,
        name: r.name,
        labels: r.labels ? r.labels.split(' | ') : []
      }));
    } finally {
      if (db) { try { db.close(); } catch (e) { } }
    }
  }

  // ───────────────────────────── שליחה ל-CRM ──────────────────────────────
  // אבטחה:
  //  • HTTPS בלבד (הטלפון מוצפן בתעבורה).
  //  • אימות דרך x-api-key — הסוד המשותף נשלח בכותרת ישירות.
  //  • GM_xmlhttpRequest עוקף את CSP של WhatsApp Web (שחוסם fetch לדומיינים חיצוניים).
  //  • לא מתעדים את גוף התשובה (responseText) — הוא עלול להחזיר את הטלפון.
  function postLead(lead) {
    const url = cfg.webhookUrl;
    console.log('[Leads Sync] POST →', url);
    if (!/^https:\/\//i.test(url)) {
      return Promise.reject(new Error('ה-Webhook חייב להיות HTTPS (כדי שהטלפון יישלח מוצפן).'));
    }

    const body = JSON.stringify({
      phone: lead.phone,
      name: lead.name || '',
      labels: lead.labels || [],
      source: 'whatsapp',
      labeledAt: new Date().toISOString(),
    });

    // GM_xmlhttpRequest עוקף CSP לחלוטין — WhatsApp Web חוסם fetch לדומיינים
    // שלא ב-connect-src (כולל base44.app). זו הסיבה שעברנו מ-@grant none.
    // הדומיין חייב להופיע ב-@connect (host בלבד) אחרת Tampermonkey יחסום.
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.sharedSecret,
        },
        data: body,
        onload: function (resp) {
          if (resp.status >= 200 && resp.status < 300) {
            resolve({ status: resp.status });
          } else {
            // מדפיסים את גוף התשובה לדיבוג (ללא טלפון — רק הודעת השרת).
            console.warn('[Leads Sync] HTTP', resp.status, '— response:', resp.responseText);
            reject(new Error('HTTP ' + resp.status));
          }
        },
        onerror: function () {
          reject(new Error('שגיאת רשת בשליחה — ודא שה-URL תקין וש-Base44 זמין.'));
        },
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

      ui.status('קורא לידים מהתגיות (מ-IndexedDB)…', 'info');
      const leads = await collectLeads();

      // אין dedup מקומי — לא שומרים כלום על המכשיר. ה-dedup הסופי הוא ה-upsert
      // בשרת (לפי טלפון), כך שאפשר לשלוח את אותו ליד שוב בלי ליצור כפילות.
      if (leads.length === 0) {
        ui.status("לא נמצאו צ'אטים תחת התגיות שנבחרו.", 'warn');
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
  const WA_GOLD = '#d4af37';
  const WA_GOLD_DIM = 'rgba(212,175,55,0.1)';
  const PANEL_BG = '#1a1a1a';
  const TEXT_PRIMARY = '#ffffff';
  const TEXT_SECONDARY = '#a0a0a0';
  const BORDER_COLOR = '#333333';

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .launcher {
      position: fixed; bottom: 22px; inset-inline-start: 22px; z-index: 2147483646;
      width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
      background: ${WA_GOLD}; color: #111; font-size: 24px; line-height: 1;
      box-shadow: 0 4px 14px rgba(0,0,0,.5); transition: transform .12s ease;
    }
    .launcher:hover { transform: scale(1.06); }
    .panel {
      position: fixed; bottom: 90px; inset-inline-start: 22px; z-index: 2147483647;
      width: 360px; max-height: 85vh; overflow-y: auto; direction: rtl;
      background: ${PANEL_BG}; color: ${TEXT_PRIMARY}; border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,.6); border: 1px solid ${BORDER_COLOR};
      display: flex; flex-direction: column;
    }
    .panel[hidden] { display: none; }
    
    /* Scrollbar */
    .panel::-webkit-scrollbar { width: 6px; }
    .panel::-webkit-scrollbar-track { background: transparent; }
    .panel::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

    .hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px 12px;
    }
    .hdr .title-wrap { display: flex; align-items: center; gap: 8px; color: ${WA_GOLD}; }
    .hdr .title { font-weight: 800; font-size: 20px; letter-spacing: 1px; }
    .hdr .icon { width: 20px; height: 20px; fill: currentColor; }
    .hdr .x { background: none; border: none; color: #555; font-size: 20px; cursor: pointer; padding: 0; transition: color .2s; }
    .hdr .x:hover { color: #fff; }

    .badges { display: flex; gap: 10px; padding: 0 20px; justify-content: center; margin-bottom: 16px; }
    .badge { font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge.ok { border: 1px solid ${WA_GOLD}; color: ${WA_GOLD}; background: ${WA_GOLD_DIM}; }
    .badge.warn { background: ${WA_GOLD}; color: #111; }
    .badge.err { border: 1px solid #ff4a4a; color: #ff4a4a; background: rgba(255, 74, 74, 0.1); }

    .subtitle { text-align: center; font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #eaeaea; }

    .actions-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 0 20px; margin-bottom: 20px;
    }
    .action-btn {
      background: transparent; border: 1px solid ${BORDER_COLOR}; border-radius: 8px;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 12px 4px; gap: 8px; cursor: pointer; color: ${TEXT_SECONDARY}; transition: all .2s;
    }
    .action-btn:hover { background: rgba(255,255,255,0.03); color: ${WA_GOLD}; border-color: #444; }
    .action-btn svg { width: 20px; height: 20px; fill: ${WA_GOLD}; }
    .action-btn span { font-size: 11px; font-weight: 600; }

    .table-container { border-top: 1px solid ${BORDER_COLOR}; border-bottom: 1px solid ${BORDER_COLOR}; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: start; padding: 12px 20px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    th { color: ${TEXT_SECONDARY}; font-weight: 600; font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    td.num { color: ${WA_GOLD}; font-weight: 700; width: 40px; }
    td.ph { direction: ltr; text-align: right; color: #e0e0e0; font-variant-numeric: tabular-nums; }
    td.name { color: #fff; }

    .settings { padding: 20px; border-top: 1px solid ${BORDER_COLOR}; background: rgba(0,0,0,0.2); }
    .settings[hidden] { display: none; }
    .settings label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 12px; color: ${TEXT_SECONDARY}; }
    .settings input {
      width: 100%; margin-top: 6px; padding: 10px 12px; border: 1px solid ${BORDER_COLOR};
      border-radius: 8px; font-size: 14px; direction: ltr; text-align: start;
      background: #111; color: #fff; outline: none; transition: border-color .2s;
    }
    .settings input:focus { border-color: ${WA_GOLD}; }
    .lbl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .lbl-head .link { background: none; border: none; color: ${WA_GOLD}; cursor: pointer; font-size: 12px; font-weight: 600; padding: 0; }
    .lbl-list { max-height: 160px; overflow-y: auto; border: 1px solid ${BORDER_COLOR}; background: #111; border-radius: 8px; padding: 6px; }
    .lbl-list::-webkit-scrollbar { width: 4px; }
    .lbl-list::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
    .lbl-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; font-weight: 500; color: #ddd; cursor: pointer; border-radius: 6px; transition: background 0.15s; margin-bottom: 2px; }
    .lbl-row:hover { background: rgba(255,255,255,0.05); }
    .lbl-row input { display: none; }
    .custom-cb { width: 18px; height: 18px; border: 2px solid #555; border-radius: 4px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; flex: 0 0 auto; }
    .lbl-row input:checked ~ .custom-cb { background: ${WA_GOLD}; border-color: ${WA_GOLD}; }
    .custom-cb::after { content: ''; width: 4px; height: 8px; border: solid #111; border-width: 0 2px 2px 0; transform: rotate(45deg); opacity: 0; transition: opacity 0.2s; margin-bottom: 2px; }
    .lbl-row input:checked ~ .custom-cb::after { opacity: 1; }
    .lbl-dot { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; border: 1px solid rgba(255,255,255,.1); }
    .lbl-text { flex: 1; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lbl-muted { color: #555; font-size: 12px; padding: 6px 4px; }
    .lbl-count { font-size: 12px; color: ${WA_GOLD}; margin-top: 8px; font-weight: 600; }
    .settings-actions { display: flex; gap: 10px; margin-top: 16px; }
    button.small { padding: 10px; font-size: 13px; flex: 1; border-radius: 8px; cursor: pointer; font-weight: 600; border: none; }
    button.small.primary { background: ${WA_GOLD_DIM}; color: ${WA_GOLD}; border: 1px solid ${WA_GOLD}; }
    button.small.danger { background: rgba(255,74,74,0.1); color: #ff4a4a; border: 1px solid #ff4a4a; }
    
    .status-area { padding: 20px; }
    .status { font-size: 13px; line-height: 1.4; text-align: center; margin-bottom: 16px; }
    .status.info { color: ${TEXT_SECONDARY}; }
    .status.success { color: ${WA_GOLD}; }
    .status.warn { color: #ffc107; }
    .status.error { color: #ff4a4a; }

    button.primary.huge {
      width: 100%; padding: 16px; border: none; border-radius: 8px; cursor: pointer;
      background: ${WA_GOLD}; color: #111; font-size: 16px; font-weight: 700;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      transition: background 0.2s;
    }
    button.primary.huge:hover { background: #f5c85b; }
    button.primary.huge:disabled { opacity: .55; cursor: not-allowed; }
    button.primary.huge svg { width: 20px; height: 20px; fill: currentColor; }

    .foot { margin: 16px 0 0; font-size: 11px; color: #555; text-align: center; }
    
    .toggle { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 0 0 16px 0; font-size: 13px; cursor: pointer; color: ${TEXT_SECONDARY}; }
    .toggle input { accent-color: ${WA_GOLD}; width: 16px; height: 16px; }
  `;

  // SVGs for icons
  const ICONS = {
    globe: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.43-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.49-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>',
    preview: '<svg viewBox="0 0 24 24"><path d="M12,4.5C7,4.5,2.73,7.61,1,12c1.73,4.39,6,7.5,11,7.5s9.27-3.11,11-7.5C21.27,7.61,17,4.5,12,4.5z M12,17 c-2.76,0-5-2.24-5-5s2.24-5,5-5s5,2.24,5,5S14.76,17,12,17z M12,9c-1.66,0-3,1.34-3,3s1.34,3,3,3s3-1.34,3-3S13.66,9,12,9z"/></svg>',
    csv: '<svg viewBox="0 0 24 24"><path d="M14,2H6C4.9,2,4,2.9,4,4v16c0,1.1,0.89,2,1.99,2H18c1.1,0,2-0.9,2-2V8L14,2z M16,18H8v-2h8V18z M16,14H8v-2h8V14z M13,9V3.5L18.5,9H13z"/></svg>',
    test: '<svg viewBox="0 0 24 24"><path d="M20,4H4C2.9,4,2,4.9,2,6v12c0,1.1,0.9,2,2,2h16c1.1,0,2-0.9,2-2V6C22,4.9,21.1,4,20,4z M20,18H4V6h16V18z M18,10l-1.41-1.41 L10,15.17l-3.59-3.59L5,13l5,5L18,10z"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>'
  };

  const UI_HTML = `
    <button class="launcher" id="wals-launch" title="סנכרון לידים" aria-label="סנכרון לידים">↗</button>
    <div class="panel" id="wals-panel" hidden>
      <div class="hdr">
        <button class="x" id="wals-close" title="סגור" aria-label="סגור">✕</button>
        <div class="title-wrap">
          <span class="title">BASE44</span>
          <span class="icon">${ICONS.globe}</span>
        </div>
      </div>
      
      <div class="badges">
        <span class="badge" id="wals-conn"></span>
        <span class="badge" id="wals-mode"></span>
      </div>

      <div class="subtitle">סנכרון נמענים ל-CRM</div>

      <div class="actions-grid">
        <button class="action-btn" id="wals-settings-btn" title="הגדרות">
          ${ICONS.settings}
          <span>הגדרות</span>
        </button>
        <button class="action-btn" id="wals-preview" title="תצוגה מקדימה">
          ${ICONS.preview}
          <span>תצוגה</span>
        </button>
        <button class="action-btn" id="wals-step0" title="בדיקת תגיות">
          ${ICONS.test}
          <span>בדיקה</span>
        </button>
        <button class="action-btn" id="wals-export" title="ייצוא לידים מתויגים ל-CSV">
          ${ICONS.csv}
          <span>אקסל</span>
        </button>
      </div>

      <div class="table-container">
        <div class="results" id="wals-results">
          <!-- טבלת תוצאות תוזרק לכאן -->
        </div>
      </div>

      <div class="settings" id="wals-settings" hidden>
        <label>כתובת Webhook (HTTPS)
          <input type="url" id="wals-url" placeholder="https://...base44.app/...">
        </label>
        <label>סוד משותף (לחתימת HMAC)
          <input type="password" id="wals-secret" placeholder="••••••••">
        </label>
        <div class="lbl-head" style="margin-top:12px;">
          <label style="margin-bottom:0">תגיות לסנכרון (בחירה מרובה)</label>
          <button class="link" id="wals-labels-reload">רענן</button>
        </div>
        <div class="lbl-list" id="wals-labels"><div class="lbl-muted">פתח כדי לטעון תגיות…</div></div>
        <div class="lbl-count" id="wals-labels-count"></div>
        <div class="settings-actions">
          <button class="primary small" id="wals-save">שמור</button>
          <button class="danger small" id="wals-clear">מחק</button>
        </div>
      </div>

      <div class="status-area">
        <div class="status info" id="wals-status">מוכן לסנכרון.</div>
        <label class="toggle"><input type="checkbox" id="wals-dry"> מצב DRY_RUN (לא שולח, רק מציג)</label>
        <button class="primary huge" id="wals-sync">
          התחל שליחה
          ${ICONS.send}
        </button>
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
        export: $('wals-export'),
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
      r.export.addEventListener('click', () => this.exportContactsCsv());
      r.settingsBtn.addEventListener('click', () => this.showSettings());
      r.labelsReload.addEventListener('click', () => this.loadLabels(true));
      r.preview.addEventListener('click', () => this.previewLeads());
      r.save.addEventListener('click', () => this.saveSettings());
      r.clear.addEventListener('click', clearLocalData);
      r.dry.addEventListener('change', () => {
        store.set(STORE.DRY_RUN, r.dry.checked);
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

      let labels = [];
      let db;
      try {
        db = await openWaModelDb();
        labels = await readIdbLabels(db);
      } catch (e) {
        console.warn('[Leads Sync] loadLabels (IndexedDB) שגיאה:', e && e.message);
      } finally {
        if (db) { try { db.close(); } catch (e) { } }
      }

      if (labels.length === 0) {
        box.innerHTML = '<div class="lbl-muted">לא נמצאו תגיות (ב-IndexedDB).</div>';
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
            '<div class="custom-cb"></div>' +
            dot +
            '<span class="lbl-text">' + escapeHtml(l.name) + '</span>' +
            '</label>'
          );
        })
        .join('');
      box.querySelectorAll('input[type=checkbox]').forEach((cb) =>
        cb.addEventListener('change', () => this.updateLabelsCount())
      );
      this._labelsLoaded = true;
      this.updateLabelsCount();
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
        const leads = await collectLeads(checked);
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

    // ייצוא לידים מתויגים ל-CSV מקומי, ישירות מ-IndexedDB (ללא wa-js, ללא webhook).
    // דורש בחירת תגיות מראש (ב"הגדרות"). הקובץ מכיל טלפונים מלאים (חריגה מודעת);
    // הפאנל והקונסול מציגים ממוסך בלבד.
    async exportContactsCsv() {
      this.clearResults();

      // 1) חייבים תגיות נבחרות. אם אין — פותחים הגדרות, טוענים תגיות, ומבקשים לבחור.
      const checked = this.getCheckedLabels();
      if (checked.length === 0) {
        this.showSettings(true);
        await this.loadLabels();
        this.status('בחר קודם לפחות תגית אחת (ב"הגדרות"), ואז לחץ שוב על "ייצוא אנשי קשר ל-CSV".', 'warn');
        return;
      }

      this.status('קורא לידים מתויגים מ-IndexedDB…', 'info');
      let db;
      try {
        db = await openWaModelDb();
        const allLabels = await readIdbLabels(db);
        const nameById = new Map(allLabels.map((l) => [l.id, l.name]));
        const labelIds = checked.map((c) => c.id).filter((x) => x != null);
        const rows = await collectLabeledLeads(db, labelIds, nameById);

        if (rows.length === 0) {
          this.status('לא נמצאו אנשי קשר תחת התגיות שנבחרו (ייתכן שרק קבוצות, או שאין שיוכים).', 'warn');
          return;
        }

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const headers = ['phone', 'name', 'labels', 'raw_id'];
        downloadCsv('whatsapp-leads-' + stamp + '.csv', buildCsv(headers, rows));

        // תצוגה בפאנל — טלפונים ממוסכים בלבד (הקובץ מכיל מלא, הפאנל לא חושף).
        const withPhone = rows.filter((r) => r.phone).length;
        this.showLeadsTable(rows.slice(0, 50).map((r) => ({ phone: maskPhone(r.phone), name: r.name })));
        this.status(
          'הורד CSV עם ' + rows.length + ' לידים (' + withPhone + ' עם טלפון). מוצגים עד 50, טלפונים ממוסכים בפאנל.',
          'success'
        );
        console.log('[Leads Sync] CSV יוצא:', rows.length, 'לידים (טלפונים מלאים בקובץ בלבד).');
      } catch (e) {
        console.error('[Leads Sync] exportContactsCsv:', e);
        this.status('שגיאה בייצוא: ' + (e && e.message ? e.message : e), 'error');
      } finally {
        if (db) { try { db.close(); } catch (e) { } }
      }
    },

    setBusy(busy) {
      if (!this.built) return;
      this.refs.sync.disabled = busy;
      this.refs.sync.innerHTML = busy ? 'מסנכרן…' : 'התחל שליחה ' + ICONS.send;
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
          (x, i) =>
            '<tr><td class="num">' + (i + 1) + '</td><td class="ph">' + escapeHtml(x.phone) + '</td><td class="name">' + escapeHtml(x.name) + '</td></tr>'
        )
        .join('');
      this.refs.results.innerHTML =
        '<table><thead><tr><th></th><th>מספר נייד</th><th>שם</th></tr></thead><tbody>' +
        body +
        '</tbody></table>';
    },

    saveSettings() {
      const r = this.refs;
      store.set(STORE.WEBHOOK_URL, r.url.value.trim());
      store.set(STORE.SHARED_SECRET, r.secret.value.trim());
      store.set(STORE.LABELS, this.getCheckedLabels());
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
