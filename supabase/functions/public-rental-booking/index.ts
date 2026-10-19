import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SITE_URL = "https://ladancestone-bot.github.io/La-Dance-Stone-lankomumas-ir-mokejimai/preview/";
const ALLOWED_ORIGINS = [
  "https://ladancestone.lt",
  "https://www.ladancestone.lt",
  "https://ladancestone-bot.github.io",
  "https://mediumspringgreen-bison-570962.hostingersite.com",
];

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}
const response = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: cors(origin) });
const clean = (v: unknown) => String(v ?? "").trim();
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const currentSiteUrl = origin === "https://mediumspringgreen-bison-570962.hostingersite.com" ? origin + "/booking-test/" : (origin === "https://ladancestone.lt" || origin === "https://www.ladancestone.lt") ? origin + "/" : SITE_URL;
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return response({ error: "Leidžiamas tik POST metodas." }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return response({ error: "Nepalaikomas svetainės adresas." }, 403, origin);
  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_API_KEY || !STRIPE_SECRET_KEY) {
    return response({ error: "Serverio konfigūracija neužbaigta. Patikrinkite el. pašto ir Stripe raktus." }, 500, origin);
  }

  try {
    const body = await req.json();
    const firstName = clean(body.firstName).slice(0, 100);
    const lastName = clean(body.lastName).slice(0, 100);
    const email = clean(body.email).toLowerCase().slice(0, 254);
    const phone = clean(body.phone).slice(0, 40);
    const date = clean(body.date);
    const startHour = Number(body.startHour);
    const duration = Number(body.duration);

    if (!firstName || !lastName || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response({ error: "Patikrinkite vardą, pavardę, telefono numerį ir el. paštą." }, 400, origin);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(startHour) || !Number.isInteger(duration) ||
        startHour < 8 || startHour > 21 || duration < 1 || duration > 6 || startHour + duration > 22 || (startHour === 21 && duration !== 1)) {
      return response({ error: "Patikrinkite pasirinktą datą, pradžios laiką ir trukmę." }, 400, origin);
    }

    // Compute the correct Europe/Vilnius UTC offset for the selected local date.
    const localStart = new Date(date + "T" + String(startHour).padStart(2, "0") + ":00:00+03:00");
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Vilnius", timeZoneName: "longOffset", year: "numeric" }).formatToParts(localStart);
    const tz = parts.find(p => p.type === "timeZoneName")?.value ?? "GMT+03:00";
    const offset = tz.includes("+02:00") ? "+02:00" : "+03:00";
    const startsAt = new Date(date + "T" + String(startHour).padStart(2, "0") + ":00:00" + offset);
    const includesFinalSlot = startHour + duration === 22;
    const isFinalSlot = startHour === 21;
    const actualDurationMinutes = includesFinalSlot ? (duration - 1) * 60 + 45 : duration * 60;
    const endsAt = new Date(startsAt.getTime() + actualDurationMinutes * 60 * 1000);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      return response({ error: "Rezervuoti galima tik būsimą laiką." }, 400, origin);
    }

    // Server-side guard: the rental must not overlap any block in the live Google Sheets timetable.
    // Fail closed if the timetable cannot be read, so the site never accepts an unchecked booking.
    const availabilityResponse = await fetch(SUPABASE_URL + "/functions/v1/public-rental-availability", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: date, endDate: date }),
    });
    const availabilityData = await availabilityResponse.json().catch(() => null);
    if (!availabilityResponse.ok || !availabilityData?.ok || !Array.isArray(availabilityData.busy)) {
      return response({ error: "Nepavyko patikrinti naujausio studijos tvarkaraščio. Pabandykite rezervuoti po kelių minučių." }, 503, origin);
    }
    const requestedStartMinute = startHour * 60;
    const requestedEndMinute = requestedStartMinute + actualDurationMinutes;
    const overlapsSchedule = availabilityData.busy.some((block: {date?: string;start?: string;end?: string;kind?: string}) => {
      if (block.date !== date || !block.start || !block.end) return false;
      const parseMinute = (value: string) => { const p = value.split(":").map(Number); return (p[0] || 0) * 60 + (p[1] || 0); };
      return parseMinute(block.start) < requestedEndMinute && parseMinute(block.end) > requestedStartMinute;
    });
    if (overlapsSchedule) {
      return response({ error: "Šis laikas pagal studijos tvarkaraštį yra užimtas. Pasirinkite kitą laiką." }, 409, origin);
    }

    const billableHours = duration;
    const price = Math.min(billableHours, 3) * 20 + Math.max(0, billableHours - 3) * 15;
    const rpc = await fetch(SUPABASE_URL + "/rest/v1/rpc/create_public_rental_booking", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_first_name: firstName, p_last_name: lastName, p_email: email, p_phone: phone,
        p_starts_at: startsAt.toISOString(), p_ends_at: endsAt.toISOString(), p_price: price,
      }),
    });
    const rpcText = await rpc.text();
    if (!rpc.ok) {
      let message = "Nepavyko išsaugoti rezervacijos. Pabandykite dar kartą.";
      try { const parsed = JSON.parse(rpcText); if (parsed.message) message = parsed.message; } catch {}
      return response({ error: message }, 409, origin);
    }

    const booking = JSON.parse(rpcText);
    const bookingId = String(booking.booking_id ?? booking.id ?? "");
    if (!bookingId) {
      console.error("Rental RPC did not return a booking id", rpcText.slice(0, 500));
      return response({ error: "Rezervacija sukurta, bet nepavyko paruošti apmokėjimo. Susisiekite info@ladancestone.lt." }, 500, origin);
    }

    const dateText = new Intl.DateTimeFormat("lt-LT", { timeZone: "Europe/Vilnius", year: "numeric", month: "long", day: "numeric" }).format(startsAt);
    const timeText = String(startHour).padStart(2, "0") + ":00–" + (includesFinalSlot ? "21:45" : String(startHour + duration).padStart(2, "0") + ":00");
    const durationText = includesFinalSlot ? (isFinalSlot ? "45 min. (apmokestinama kaip viena valanda)" : (duration - 1) + " val. 45 min. (apmokestinama kaip " + duration + " val.)") : duration + " val.";
    const safeName = escapeHtml(firstName + " " + lastName);

    // Create the Stripe Checkout session on the server; never expose the secret key to the browser.
    const stripeForm = new URLSearchParams();
    stripeForm.set("mode", "payment");
    // Give online payments exactly 24 hours; Stripe emits checkout.session.expired when this link expires.
    stripeForm.set("expires_at", String(Math.floor(Date.now() / 1000) + 24 * 60 * 60));
    stripeForm.set("customer_email", email);
    stripeForm.set("client_reference_id", bookingId);
    stripeForm.set("phone_number_collection[enabled]", "true");
    stripeForm.set("line_items[0][quantity]", "1");
    stripeForm.set("line_items[0][price_data][currency]", "eur");
    stripeForm.set("line_items[0][price_data][unit_amount]", String(Math.round(price * 100)));
    stripeForm.set("line_items[0][price_data][product_data][name]", "La Dance Stone šokių studija – studijos nuoma");
    stripeForm.set("line_items[0][price_data][product_data][description]", dateText + " | " + timeText);
    stripeForm.set("payment_intent_data[receipt_email]", email);
    stripeForm.set("payment_intent_data[metadata][payment_kind]", "rental");
    stripeForm.set("payment_intent_data[metadata][rental_id]", bookingId);
    stripeForm.set("metadata[payment_kind]", "rental");
    stripeForm.set("metadata[rental_id]", bookingId);
    stripeForm.set("metadata[customer_name]", (firstName + " " + lastName).slice(0, 500));
    stripeForm.set("metadata[customer_email]", email);
    stripeForm.set("metadata[customer_phone]", phone);
    stripeForm.set("metadata[rental_date]", date);
    stripeForm.set("metadata[start_time]", String(startHour).padStart(2, "0") + ":00");
    stripeForm.set("metadata[end_time]", isFinalSlot ? "21:45" : String(startHour + duration).padStart(2, "0") + ":00");
    stripeForm.set("success_url", currentSiteUrl + "?rental_payment=success");
    stripeForm.set("cancel_url", currentSiteUrl + "?rental_payment=cancelled");

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: stripeForm,
    });
    const stripeText = await stripeResponse.text();
    if (!stripeResponse.ok) {
      console.error("Stripe Checkout creation failed", stripeResponse.status, stripeText.slice(0, 500));
      return response({ ok: true, bookingId, emailSent: false, paymentLinkCreated: false, message: "Rezervacija išsaugota, tačiau mokėjimo nuorodos sukurti nepavyko. Susisiekite info@ladancestone.lt." }, 200, origin);
    }
    const session = JSON.parse(stripeText);
    if (!session.url) {
      console.error("Stripe Checkout session returned no URL", stripeText.slice(0, 500));
      return response({ ok: true, bookingId, emailSent: false, paymentLinkCreated: false, message: "Rezervacija išsaugota, tačiau mokėjimo nuorodos gauti nepavyko." }, 200, origin);
    }

    const dbUpdate = await fetch(SUPABASE_URL + "/rest/v1/studio_rentals?id=eq." + encodeURIComponent(bookingId), {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ payment_method: "stripe", stripe_checkout_session_id: session.id, stripe_payment_status: "unpaid" }),
    });
    if (!dbUpdate.ok) {
      console.error("Could not save Stripe session id", dbUpdate.status, (await dbUpdate.text()).slice(0, 500));
    }

    const payUrl = String(session.url);
    const cashUrl = currentSiteUrl + "?rental_cash=" + encodeURIComponent(bookingId) + "&email=" + encodeURIComponent(email);
    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "La Dance Stone šokių studija <info@ladancestone.lt>",
        to: [email],
        reply_to: "info@ladancestone.lt",
        subject: "Studijos nuomos rezervacija – apmokėjimas",
        html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0;padding:0;background:#35111f;background-color:#35111f">
<tr><td align="center" style="padding:20px 10px;background:#35111f;background-color:#35111f">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;background:#35111f;background-color:#35111f;font-family:Arial,Helvetica,sans-serif;color:#fff7f2;line-height:1.6">
<tr><td align="center" style="padding:30px 20px 24px;border:1px solid #79505b;border-bottom:0;border-radius:20px 20px 0 0;background:#35111f;background-color:#35111f">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.2;font-weight:bold;color:#fff7f2">La Dance Stone</div>
<div style="margin-top:8px;font-size:10px;line-height:1.5;font-weight:bold;letter-spacing:3px;color:#e0c58a;text-transform:uppercase">ŠOKIŲ STUDIJA</div>
<div style="margin-top:22px;font-size:10px;line-height:1.5;font-weight:bold;letter-spacing:2px;color:#e0c58a;text-transform:uppercase">STUDIJOS NUOMA</div>
<div style="margin-top:7px;font-family:Georgia,'Times New Roman',serif;font-size:27px;line-height:1.25;font-weight:bold;color:#fff7f2">Jūsų rezervacija gauta</div>
</td></tr>
<tr><td style="padding:22px 18px 24px;border:1px solid #79505b;border-top:1px solid #79505b;border-radius:0 0 20px 20px;background:#421827;background-color:#421827">
<p style="margin:0 0 12px;color:#fff7f2;font-size:15px;line-height:1.65">Sveiki, ${safeName}!</p>
<p style="margin:0 0 20px;color:#f4e8e7;font-size:14px;line-height:1.7">Gavome jūsų studijos nuomos rezervaciją. Žemiau rasite rezervacijos informaciją ir abu atsiskaitymo būdus.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 18px;border-collapse:separate;background:#4d1c2e;background-color:#4d1c2e">
<tr><td style="padding:21px 20px;border:1px solid #d9bd7a;border-radius:16px;background:#4d1c2e;background-color:#4d1c2e">
<div style="font-size:10px;line-height:1.5;font-weight:bold;letter-spacing:2px;color:#e7cc8e;text-transform:uppercase">BENDRA REZERVACIJOS KAINA</div>
<div style="margin:5px 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:42px;line-height:1.15;font-weight:bold;color:#ffffff">${price} €</div>
<div style="font-size:14px;line-height:1.6;color:#fff1eb">${escapeHtml(dateText)} · ${escapeHtml(durationText)}</div>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 18px;border-collapse:separate;background:#f8f0e8;background-color:#f8f0e8">
<tr><td style="padding:18px 18px 10px;border:1px solid #d9c5b5;border-radius:15px;background:#f8f0e8;background-color:#f8f0e8;color:#39212a">
<div style="font-size:10px;line-height:1.5;font-weight:bold;letter-spacing:2px;color:#79503b;text-transform:uppercase;margin-bottom:12px">REZERVACIJOS INFORMACIJA</div>
<p style="margin:0 0 10px;color:#39212a;font-size:14px;line-height:1.55"><strong style="color:#79503b">Data</strong><br>${escapeHtml(dateText)}</p>
<p style="margin:0 0 10px;color:#39212a;font-size:14px;line-height:1.55"><strong style="color:#79503b">Laikas</strong><br>${escapeHtml(timeText)}</p>
<p style="margin:0 0 10px;color:#39212a;font-size:14px;line-height:1.55"><strong style="color:#79503b">Trukmė</strong><br>${escapeHtml(durationText)}</p>
<p style="margin:0 0 8px;color:#39212a;font-size:14px;line-height:1.55"><strong style="color:#79503b">Rezervacijos būsena</strong><br>Laukiama apmokėjimo arba mokėjimo būdo patvirtinimo</p>
</td></tr></table>
${isFinalSlot ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 18px"><tr><td style="padding:16px;border:1px solid #e2b9c5;border-radius:12px;background:#f8e9ed;background-color:#f8e9ed;color:#481824"><div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.3;font-weight:bold;color:#481824;margin-bottom:7px">Svarbus priminimas apie pastato uždarymą</div><p style="margin:0 0 7px;font-size:14px;line-height:1.6;color:#481824">Pastatas automatiškai užrakinamas <strong>22.00 val.</strong></p><p style="margin:0 0 7px;font-size:14px;line-height:1.6;color:#481824">Paskutinis rezervuojamas laikotarpis: <strong>21.00–21.45 val.</strong></p><p style="margin:0 0 7px;font-size:14px;line-height:1.6;color:#481824">Šio 45 minučių laikotarpio kaina – <strong>20 €</strong>, kaip už vieną valandą.</p><p style="margin:0;font-size:14px;line-height:1.6;color:#481824">Prašome susitvarkyti ir išeiti iš pastato iki 22.00 val.</p></td></tr></table>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 0;border-collapse:separate">
<tr><td align="center" style="padding:0 0 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate"><tr><td align="center" bgcolor="#e4ca8e" style="background:#e4ca8e;background-color:#e4ca8e;border:1px solid #f0dba6;border-radius:12px"><a href="${escapeHtml(payUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;padding:15px 16px;border-radius:12px;color:#35111f;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:22px;font-weight:bold;text-decoration:none;text-align:center">Apmokėti internetu · ${price} €</a></td></tr></table></td></tr>
<tr><td style="padding:4px 3px 16px;color:#fff1eb;font-size:13px;line-height:1.65">Jei pasirinkote mokėjimą kortele internetu, apmokėkite rezervaciją per <strong style="color:#f2d99e">24 valandas</strong> nuo rezervacijos pateikimo. Negavus apmokėjimo per nurodytą laiką, rezervacija bus automatiškai atšaukta.</td></tr>
<tr><td align="center" style="padding:0 0 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate"><tr><td align="center" bgcolor="#421827" style="background:#421827;background-color:#421827;border:1px solid #c8a9ae;border-radius:12px"><a href="${escapeHtml(cashUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;padding:14px 16px;border-radius:12px;color:#fff7f2;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;font-weight:bold;text-decoration:none;text-align:center">Pasirinkti mokėjimą grynaisiais</a></td></tr></table></td></tr>
<tr><td style="padding:4px 3px 18px;color:#f4e8e7;font-size:13px;line-height:1.65">Pasirinkus mokėjimą grynaisiais, už rezervaciją atsiskaitoma atvykus į studiją. 24 valandų apmokėjimo terminas šiam būdui netaikomas.</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 18px;border-collapse:separate;background:#35111f;background-color:#35111f">
<tr><td style="padding:17px 18px;border:1px solid #9b7a56;border-radius:14px;background:#35111f;background-color:#35111f;color:#fff7f2">
<div style="font-size:10px;line-height:1.5;font-weight:bold;letter-spacing:2px;color:#e4ca8e;margin-bottom:7px">STUDIJOS ADRESAS</div>
<a href="https://maps.google.com/?q=V.+Krev%C4%97s+pr.+57,+Kaunas" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;font-weight:bold;color:#fff7f2;text-decoration:none">⌖ V. Krėvės pr. 57, Kaunas&nbsp; →</a>
</td></tr></table>
<p style="margin:0 0 16px;color:#f4e8e7;font-size:13px;line-height:1.7">Klausimais kreipkitės į <a href="mailto:info@ladancestone.lt" style="color:#e4ca8e;text-decoration:underline">info@ladancestone.lt</a> arba atsakykite į šį laišką.</p>
<div style="padding-top:16px;border-top:1px solid #79505b;text-align:center;color:#d6bfc3;font-size:10px;line-height:1.6;letter-spacing:1px">LA DANCE STONE · ŠOKIŲ STUDIJA</div>
</td></tr></table></td></tr></table>`,
      }),
    });
    if (!mail.ok) {
      const mailError = await mail.text();
      console.error("Resend send failed for booking", bookingId, mail.status, mailError.slice(0, 500));
      return response({ ok: true, bookingId, emailSent: false, paymentLinkCreated: true, checkoutUrl: payUrl, message: "Rezervacija ir mokėjimo nuoroda paruoštos, tačiau laiško išsiųsti nepavyko. Susisiekite info@ladancestone.lt." }, 200, origin);
    }
    return response({ ok: true, bookingId, emailSent: true, paymentLinkCreated: true, checkoutUrl: payUrl, message: "Rezervacija išsaugota. Į el. paštą išsiuntėme rezervacijos informaciją ir saugią apmokėjimo nuorodą." }, 200, origin);
  } catch (error) {
    console.error("public-rental-booking error", error);
    return response({ error: "Įvyko techninė klaida. Rezervacija nepateikta, pabandykite dar kartą." }, 500, origin);
  }
});