# דוגמת endpoint ב-Base44 לקבלת לידים

> זו **דוגמה מתועדת** בלבד — התאם אותה לסכמה האמיתית של טבלת הלידים שלך ב-Base44.
> הרעיון: לאמת את מפתח ה-API שבכותרת, ולעשות **upsert** לפי מספר טלפון
> (ה-dedup הסופי קורה כאן בשרת — בצד הלקוח לא נשמר כלום).

## מה הסקריפט שולח

`POST` עם הכותרות:

```
Content-Type: application/json
x-api-key: <הסוד המשותף, כפי שהוזן בהגדרות הפאנל>
```

> שים לב: הסוד נשלח ישירות בכותרת `x-api-key` **מעל HTTPS בלבד** (הסקריפט חוסם URL
> שאינו HTTPS). הוא לעולם לא מופיע בקוד הציבורי או בריפו — רק ב-`localStorage` של
> הדפדפן ובגוף הבקשה המוצפנת.

גוף הבקשה (JSON):

```json
{
  "phone": "+972501234567",
  "name": "שם הצ'אט כפי שמופיע ב-WhatsApp",
  "labels": ["לידים חדשים לטיפול", "צילומי חתונה"],
  "source": "whatsapp",
  "labeledAt": "2026-06-08T10:30:00.000Z"
}
```

> `labels` הוא מערך שמות התגיות שמהן הגיע הליד (יכול להכיל יותר מאחת אם הצ'אט תויג
> בכמה מהתגיות שנבחרו).

## אין צורך ב-CORS

הסקריפט שולח את הבקשה דרך `GM_xmlhttpRequest` (Tampermonkey), שעוקף את ה-CSP של
WhatsApp Web ואינו כפוף ל-CORS של הדפדפן — **אין preflight (`OPTIONS`) ואין צורך
בכותרות `Access-Control-Allow-*`**. הדרישה היחידה בצד הלקוח: הדומיין מופיע ב-`@connect`
של הסקריפט (host בלבד, למשל `base44.app`). לכן ה-endpoint יכול להתעלם מ-CORS לחלוטין.

## מה ה-endpoint צריך לעשות

1. **לדחות אם לא HTTPS** ואם המתודה אינה POST.
2. **אימות מפתח API**: להשוות את `x-api-key` לסוד שמאוחסן בצד Base44 בהשוואת
   **זמן-קבוע** (constant-time) כדי למנוע timing attacks. אם לא תואם → `401`.
3. **Upsert** לטבלת הלידים לפי `phone` (המקור היחיד לאמת לגבי כפילויות).
4. להחזיר `200` בהצלחה — **בלי להחזיר נתוני לידים בגוף התשובה** (write-only).

## דוגמת לוגיקה (פסאודו)

```js
// Base44 backend function — דוגמה להמחשה, התאם ל-SDK/schema האמיתיים שלך.
import crypto from 'node:crypto';

export default async function handler(req) {
  // 1) רק POST
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // 2) אימות מפתח API בהשוואת זמן-קבוע
  const provided = req.headers['x-api-key'] || '';
  const expected = process.env.LEADS_API_KEY || '';
  const ok =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) return new Response('Unauthorized', { status: 401 });

  // 3) פענוח ה-payload ו-upsert לפי טלפון
  const { phone, name, labels, source, labeledAt } = await req.json();
  if (!phone) return new Response('Missing phone', { status: 400 });

  const existing = await Leads.filter({ phone }); // דוגמה — החלף ב-API האמיתי
  if (existing && existing.length > 0) {
    await Leads.update(existing[0].id, { name, labels, last_seen: labeledAt });
  } else {
    await Leads.create({ phone, name, labels, source, created_at: labeledAt });
  }

  // 4) write-only — לא מחזירים נתוני לידים.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

## המלצות אבטחה נוספות (היכן שהדאטה באמת יושבת)

- **Write-only**: אל תחשוף GET/endpoint שמחזיר רשימת לידים בלי אימות חזק. כאן נמצא
  כל מאגר הטלפונים — זו נקודת הסיכון האמיתית, לא הדפדפן של המשתמש.
- **Rate limiting**: הגבל בקשות לכתובת/מפתח כדי למנוע הצפה בלידים מזויפים.
- **לוגים**: אל תכתוב טלפון מלא ללוגים של השרת — מסך (`+972***67`) או דלג. אל תכתוב
  את `x-api-key` ללוגים.
- **אחסון הסוד**: שמור את `LEADS_API_KEY` כ-Secret/משתנה סביבה בצד Base44,
  לעולם לא בקוד הציבורי. סובב אותו מדי פעם.
- **העדף auth מובנה**: אם ל-Base44 יש אימות מובנה לפונקציות/endpoints, עדיף עליו
  על-פני סוד עשוי-יד.

## הערות

- הלקוח **לא** שומר כלום מקומית (אין dedup בצד הלקוח) — לכן ייתכן שאותו ליד יישלח
  שוב בסנכרון הבא; ה-`upsert` כאן מבטיח שלא תיווצר כפילות.
- הסוד מגן על הערוץ (מי רשאי לכתוב); המאגר עצמו מוגן ע"י ההמלצות שלמעלה.
