# דוגמת endpoint ב-Base44 לקבלת לידים

> זו **דוגמה מתועדת** בלבד — התאם אותה לסכמה האמיתית של טבלת הלידים שלך ב-Base44.
> הרעיון: לאמת את הסוד המשותף, ולעשות **upsert** לפי מספר טלפון (ה-dedup הסופי קורה כאן בשרת).

## מה הסקריפט שולח

`POST` עם הכותרות:

```
Content-Type: application/json
x-api-key: <הסוד המשותף שהוגדר ב-"הגדרות חיבור ל-CRM">
```

גוף הבקשה (JSON):

```json
{
  "phone": "+972501234567",
  "name": "שם הצ'אט כפי שמופיע ב-WhatsApp",
  "source": "whatsapp-web",
  "synced_at": "2026-06-08T10:30:00.000Z"
}
```

## מה ה-endpoint צריך לעשות

1. **לאמת** את הכותרת `x-api-key` מול סוד שמור (משתנה סביבה / Secret ב-Base44).
   אם לא תואם → להחזיר `401`.
2. **Upsert** לטבלת הלידים לפי `phone`:
   - אם טלפון קיים → לא ליצור כפילות (אפשר לעדכן `name`/`last_seen` לפי הצורך).
   - אם חדש → ליצור רשומה חדשה.
3. להחזיר `200` בהצלחה.

## דוגמת לוגיקה (פסאודו / Base44 function)

הקוד תלוי ב-SDK של Base44 וב-schema שלך. להלן שלד להמחשה בלבד:

```js
// Base44 backend function — דוגמה להמחשה, התאם ל-SDK/schema האמיתיים שלך.
export default async function handler(req) {
  // 1) אימות הסוד המשותף
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.LEADS_SHARED_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 2) קריאת ה-payload
  const { phone, name, source, synced_at } = await req.json();
  if (!phone) {
    return new Response('Missing phone', { status: 400 });
  }

  // 3) upsert לפי טלפון (החלף ב-API האמיתי של טבלת הלידים ב-Base44)
  const existing = await Leads.filter({ phone }); // דוגמה
  if (existing && existing.length > 0) {
    await Leads.update(existing[0].id, { name, last_seen: synced_at });
  } else {
    await Leads.create({ phone, name, source, created_at: synced_at });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

## הערות

- ה-`x-api-key` הוא הגנה בסיסית. שמור אותו כ-Secret בצד Base44, ואל תכניס אותו לקוד הציבורי.
- מומלץ לתעד/ללוג בקשות נכשלות (401/400) כדי לאתר תקלות הגדרה.
- הסקריפט עושה dedup קל בצד הלקוח, אבל **המקור היחיד לאמת** לגבי כפילויות הוא ה-upsert כאן.
