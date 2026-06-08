# דוגמת endpoint ב-Base44 לקבלת לידים

> זו **דוגמה מתועדת** בלבד — התאם אותה לסכמה האמיתית של טבלת הלידים שלך ב-Base44.
> הרעיון: לאמת את חתימת ה-HMAC, לדחות בקשות ישנות (replay), ולעשות **upsert** לפי
> מספר טלפון (ה-dedup הסופי קורה כאן בשרת — בצד הלקוח לא נשמר כלום).

## מה הסקריפט שולח

`POST` עם הכותרות:

```
Content-Type: application/json
X-Timestamp: <שניות מאז epoch, כפי שחושב בלקוח>
X-Signature: <hex של HMAC-SHA256(secret, "<X-Timestamp>.<גוף הבקשה הגולמי>")>
```

> שים לב: **הסוד עצמו לא נשלח** בשום כותרת. נשלחת רק החתימה. כך הסוד לעולם לא
> חשוף בתעבורה ולא נכתב ללוגים של פרוקסי/CDN.

גוף הבקשה (JSON), בדיוק כפי שנחתם:

```json
{
  "phone": "+972501234567",
  "name": "שם הצ'אט כפי שמופיע ב-WhatsApp",
  "labels": ["לידים חדשים לטיפול", "צילומי חתונה"],
  "source": "whatsapp-web",
  "synced_at": "2026-06-08T10:30:00.000Z"
}
```

> `labels` הוא מערך שמות התגיות שמהן הגיע הליד (יכול להכיל יותר מאחת אם הצ'אט תויג
> בכמה מהתגיות שנבחרו). השדה נחתם כחלק מה-body ב-HMAC, כמו שאר הגוף.

## חובה: CORS

הסקריפט רץ ב-`web.whatsapp.com` ושולח את הבקשה ב-`fetch` (הוא רץ עם `@grant none`).
לכן **ה-endpoint חייב לאשר CORS**, אחרת הדפדפן יחסום את הבקשה:

- **מענה ל-`OPTIONS` (preflight)** עם הכותרות:
  ```
  Access-Control-Allow-Origin: https://web.whatsapp.com
  Access-Control-Allow-Methods: POST, OPTIONS
  Access-Control-Allow-Headers: Content-Type, X-Timestamp, X-Signature
  Access-Control-Max-Age: 86400
  ```
  (ה-preflight נשלח כי אנחנו מוסיפים כותרות `X-Timestamp`/`X-Signature`.)
- **בתשובת ה-`POST`** להחזיר גם `Access-Control-Allow-Origin: https://web.whatsapp.com`.

## מה ה-endpoint צריך לעשות

1. **לטפל ב-`OPTIONS`** (preflight) ולהחזיר את כותרות ה-CORS שלמעלה.
2. **לדחות אם לא HTTPS** ואם המתודה אינה POST.
3. **בדיקת replay**: לוודא ש-`X-Timestamp` נמצא בחלון של ±5 דקות מהשעון של השרת.
   אם לא → `401`. זה מונע שליחה חוזרת של בקשה שצותתה.
4. **אימות חתימה**: לחשב `HMAC-SHA256(secret, X-Timestamp + "." + rawBody)` ולהשוות
   ל-`X-Signature` בהשוואת **זמן-קבוע** (constant-time) כדי למנוע timing attacks.
   אם לא תואם → `401`.
   ⚠️ חשוב: לחתום על **גוף הבקשה הגולמי** (raw bytes) — לא על JSON ש-serialized מחדש,
   אחרת החתימה לא תתאים.
5. **Upsert** לטבלת הלידים לפי `phone` (המקור היחיד לאמת לגבי כפילויות).
6. להחזיר `200` בהצלחה (עם כותרת `Access-Control-Allow-Origin`) — **בלי להחזיר נתוני
   לידים בגוף התשובה** (write-only).

## דוגמת לוגיקה (פסאודו)

```js
// Base44 backend function — דוגמה להמחשה, התאם ל-SDK/schema האמיתיים שלך.
import crypto from 'node:crypto';

const MAX_SKEW_SEC = 300; // ±5 דקות

const CORS = {
  'Access-Control-Allow-Origin': 'https://web.whatsapp.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Timestamp, X-Signature',
};

export default async function handler(req) {
  // 0) preflight CORS
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

  // 1) קריאת הגוף הגולמי (לפני JSON.parse) — חובה לחתימה תקינה
  const rawBody = await req.text();
  const ts = req.headers['x-timestamp'] || '';
  const sig = req.headers['x-signature'] || '';

  // 2) בדיקת replay לפי חותמת הזמן
  const now = Math.floor(Date.now() / 1000);
  if (!ts || Math.abs(now - Number(ts)) > MAX_SKEW_SEC) {
    return new Response('Stale or missing timestamp', { status: 401 });
  }

  // 3) אימות חתימת HMAC בהשוואת זמן-קבוע
  const expected = crypto
    .createHmac('sha256', process.env.LEADS_SHARED_SECRET)
    .update(ts + '.' + rawBody)
    .digest('hex');
  const ok =
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return new Response('Bad signature', { status: 401 });

  // 4) פענוח ה-payload ו-upsert לפי טלפון
  const { phone, name, labels, source, synced_at } = JSON.parse(rawBody);
  if (!phone) return new Response('Missing phone', { status: 400 });

  const existing = await Leads.filter({ phone }); // דוגמה — החלף ב-API האמיתי
  if (existing && existing.length > 0) {
    await Leads.update(existing[0].id, { name, labels, last_seen: synced_at });
  } else {
    await Leads.create({ phone, name, labels, source, created_at: synced_at });
  }

  // 5) write-only — לא מחזירים נתוני לידים. כל תשובה (כולל 401/400) צריכה כותרות CORS.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
```

> שים לב: גם תשובות השגיאה (401/400) צריכות לכלול את כותרות ה-CORS, אחרת הדפדפן
> "יבלע" את התשובה והסקריפט יראה שגיאת רשת גנרית במקום הקוד האמיתי.

## המלצות אבטחה נוספות (היכן שהדאטה באמת יושבת)

- **Write-only**: אל תחשוף GET/endpoint שמחזיר רשימת לידים בלי אימות חזק. כאן נמצא
  כל מאגר הטלפונים — זו נקודת הסיכון האמיתית, לא הדפדפן של המשתמש.
- **Rate limiting**: הגבל בקשות לכתובת/מפתח כדי למנוע הצפה בלידים מזויפים.
- **לוגים**: אל תכתוב טלפון מלא ללוגים של השרת — מסך (`+972***67`) או דלג.
- **אחסון הסוד**: שמור את `LEADS_SHARED_SECRET` כ-Secret/משתנה סביבה בצד Base44,
  לעולם לא בקוד הציבורי.
- **העדף auth מובנה**: אם ל-Base44 יש אימות מובנה לפונקציות/endpoints, עדיף עליו
  על-פני סוד עשוי-יד.

## הערות

- הלקוח **לא** שומר כלום מקומית (אין dedup בצד הלקוח) — לכן ייתכן שאותו ליד יישלח
  שוב בסנכרון הבא; ה-`upsert` כאן מבטיח שלא תיווצר כפילות.
- כל החתימה/הזמן נועדו להגן על הערוץ; המאגר עצמו מוגן ע"י ההמלצות שלמעלה.
