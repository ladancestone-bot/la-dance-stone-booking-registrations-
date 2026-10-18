import Stripe from "npm:stripe@^22";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2025-03-31.basil",
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function autoCreateInvoiceIfFullyPaid(monthlyChargeId: string) {
  try {
    const { data: charge, error } = await supabaseAdmin.from("monthly_charges").select("amount_due,amount_paid").eq("id", monthlyChargeId).maybeSingle();
    if (error || !charge || Number(charge.amount_paid || 0) + 0.00001 < Number(charge.amount_due || 0)) return;
    const response = await fetch(SUPABASE_URL + "/functions/v1/create-saskaita123-invoice", {
      method: "POST",
      headers: { Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, apikey: SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_charge_id: monthlyChargeId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.error) console.error("Automatic Sąskaita123 invoice creation failed", monthlyChargeId, response.status, result);
  } catch (error) {
    console.error("Automatic Sąskaita123 invoice call failed", monthlyChargeId, error);
  }
}
async function autoCreateRentalInvoice(rentalId: string) {
  try {
    const response = await fetch(SUPABASE_URL + "/functions/v1/create-rental-saskaita123-invoice", {
      method: "POST",
      headers: { Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, apikey: SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ rental_id: rentalId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.error) console.error("Automatic rental invoice creation failed", rentalId, response.status, result);
  } catch (error) { console.error("Automatic rental invoice call failed", rentalId, error); }
}
async function autoCreateRegistrationInvoice(orderId: string) {
  try {
    const response = await fetch(SUPABASE_URL + "/functions/v1/create-registration-saskaita123-invoice", {
      method: "POST",
      headers: { Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, apikey: SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.error) console.error("Automatic registration invoice creation failed", orderId, response.status, result);
  } catch (error) { console.error("Automatic registration invoice call failed", orderId, error); }
}
const GUIDE_ID = "1vjPK0VMwq0Kuxk5lIQfucvHcBPLJ9paa";
const GUIDE_URL = "https://drive.google.com/uc?export=download&id=" + GUIDE_ID;
async function getGuideAttachment(): Promise<{filename:string;content:string}|null> {
  try {
    const res = await fetch("https://drive.google.com/uc?export=download&id=" + GUIDE_ID);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 4 || String.fromCharCode(...bytes.subarray(0, 4)) !== "%PDF") return null;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { filename: "STUDIJOS NAUDOJIMOSI ATMINTINĖ.pdf", content: btoa(binary) };
  } catch (error) { console.error("Could not attach studio guide", error); return null; }
}
async function sendRentalPaidConfirmation(rental: any, email: string | null): Promise<boolean> {
  if (!email) return false;
  const name = String(rental.customer_name || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dateText = rental.starts_at
    ? new Intl.DateTimeFormat("lt-LT", { timeZone: "Europe/Vilnius", year: "numeric", month: "long", day: "numeric" }).format(new Date(rental.starts_at))
    : "—";
  const timeFmt = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Vilnius", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
  const timeText = rental.starts_at && rental.ends_at ? timeFmt(rental.starts_at) + "–" + timeFmt(rental.ends_at) : "—";
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#30271f;line-height:1.7">
    <div style="padding:8px 0 22px;border-bottom:1px solid #e5d8c7;margin-bottom:24px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:25px;line-height:1.15;font-weight:700;letter-spacing:-.02em;color:#481824">La Dance Stone</div>
      <div style="margin-top:6px;font-family:Arial,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:2px;color:#a9894d;text-transform:uppercase;text-align:center">ŠOKIŲ STUDIJA</div>
    </div>
    <p>Sveiki, ${name}!</p>
    <h2 style="font-family:Georgia,serif;color:#481824">Rezervacija patvirtinta</h2>
    <p>Gavome jūsų apmokėjimą. Jūsų studijos nuomos rezervacija patvirtinta.</p>
    <div style="background:#f7f2ec;padding:18px;border-radius:12px">
      <p><strong>Data:</strong> ${dateText}</p>
      <p><strong>Laikas:</strong> ${timeText}</p>
      <p><strong>Rezervacijos kaina:</strong> ${Number(rental.price)} €</p>
      <p><strong>Rezervacijos būsena:</strong> Patvirtinta</p>
      <p><strong>Apmokėjimo būsena:</strong> Apmokėta internetu</p>
    </div>
    <div style="border:2px solid #b59655;border-radius:12px;padding:16px;margin:22px 0">
      <p style="font-size:17px;font-weight:bold;color:#481824;margin-top:0">SVARBU: prieš vykstant į studiją būtina perskaityti atmintinę.</p>
      <p>Atmintinėje rasite instrukcijas, kaip patekti į studiją, naudotis patalpomis ir ką atlikti prieš išeinant. Prašome ją perskaityti dar prieš atvykstant.</p>
      <p><a href="${GUIDE_URL}" style="display:inline-block;background:#481824;color:#fff;padding:13px 20px;border-radius:24px;text-decoration:none;font-weight:bold">Perskaityti studijos atmintinę</a></p>
    </div>
    <p>Atmintinė pasiekiama paspaudus aukščiau esantį mygtuką.</p>
    <p><strong>Studijos adresas:</strong> V. Krėvės pr. 57, Kaunas.</p>
    <p>Klausimais kreipkitės į <a href="mailto:info@ladancestone.lt">info@ladancestone.lt</a>.</p>
    <div style="margin-top:28px;padding-top:18px;border-top:1px solid #e5d8c7">
      <p style="margin-bottom:2px">Iki susitikimo!</p>
      <p style="margin-top:0;font-weight:700;font-size:18px">La Dance Stone šokių studija</p>
    </div>
  </div>`;
  const attachment = await getGuideAttachment();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + (Deno.env.get("RESEND_API_KEY") ?? ""), "Content-Type": "application/json", "Idempotency-Key": "rental-paid-" + rental.id },
    body: JSON.stringify({ from: "La Dance Stone šokių studija <info@ladancestone.lt>", to: [email], reply_to: "info@ladancestone.lt", subject: "Rezervacija patvirtinta – svarbi studijos atmintinė", html, ...(attachment ? { attachments: [attachment] } : {}) }),
  });
  if (!res.ok) { console.error("Paid rental confirmation email failed", rental.id, res.status, (await res.text()).slice(0, 500)); return false; }
  return true;
}
Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error("Stripe signature verification failed:", err);
    return new Response("bad signature", { status: 400 });
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;
    const metadata = invoice.metadata ?? {};
    if (metadata.monthly_charge_id) {
      const stripePaymentId = invoice.payment_intent ? String(invoice.payment_intent) : String(invoice.id);
      const { data: charge } = await supabaseAdmin.from("monthly_charges").select("id,student_id,amount_due,amount_paid,payer_id").eq("id",metadata.monthly_charge_id).maybeSingle();
      if (!charge) return new Response("charge not found",{status:404});
      const { data: existingPayment } = await supabaseAdmin.from("payments").select("id").eq("stripe_payment_id",stripePaymentId).maybeSingle();
      if (existingPayment) {
        if (Number(charge.amount_paid || 0) + 0.00001 >= Number(charge.amount_due || 0)) await autoCreateInvoiceIfFullyPaid(charge.id);
        return Response.json({received:true,duplicate:true});
      }
      const amount=Math.min(Number(invoice.amount_paid||0)/100,Math.max(0,Number(charge.amount_due)-Number(charge.amount_paid)));
      if(amount<=0)return Response.json({received:true,already_paid:true});
      const newPaid=Number(charge.amount_paid)+amount;
      const status=newPaid>=Number(charge.amount_due)?"paid":"partially_paid";
      const {error:updateError}=await supabaseAdmin.from("monthly_charges").update({amount_paid:newPaid,status,updated_at:new Date().toISOString()}).eq("id",charge.id);
      if(updateError)return new Response("charge update failed",{status:500});
      const {error:paymentError}=await supabaseAdmin.from("payments").insert({monthly_charge_id:charge.id,student_id:charge.student_id,amount,payment_method:"stripe",paid_at:new Date().toISOString(),stripe_payment_id:stripePaymentId,received_by:null,payer_id:charge.payer_id||null,notes:"Stripe Invoice"});
      if(paymentError)return new Response("payment creation failed",{status:500});
          if (status === "paid") await autoCreateInvoiceIfFullyPaid(charge.id);
    }
    return Response.json({received:true});
  }
  if (event.type === "checkout.session.expired") {
    const expiredSession = event.data.object as Stripe.Checkout.Session;
    const expiredMetadata = expiredSession.metadata ?? {};
    if (expiredMetadata.payment_kind === "rental" && expiredMetadata.rental_id) {
      const { data: rental, error: rentalError } = await supabaseAdmin
        .from("studio_rentals")
        .select("id,payment_status,payment_method,stripe_checkout_session_id")
        .eq("id", expiredMetadata.rental_id)
        .maybeSingle();
      if (rentalError) {
        console.error("Expired rental lookup failed", expiredMetadata.rental_id, rentalError);
        return new Response("rental lookup failed", { status: 500 });
      }
      // Only expire the matching unpaid online reservation; never cancel cash bookings or paid rentals.
      if (rental && rental.payment_status !== "paid" && rental.payment_method === "stripe" &&
          rental.stripe_checkout_session_id === expiredSession.id) {
        const { error: cancelError } = await supabaseAdmin
          .from("studio_rentals")
          .update({
            payment_status: "cancelled",
            stripe_payment_status: "expired",
            reservation_status: "cancelled",
            is_active: false,
            updated_at: new Date().toISOString(),
          })
          .eq("id", rental.id)
          .eq("payment_status", "pending")
          .eq("payment_method", "stripe");
        if (cancelError) {
          console.error("Expired rental cancellation failed", rental.id, cancelError);
          return new Response("rental cancellation failed", { status: 500 });
        }
        return Response.json({ received: true, rental_expired: true, rental_id: rental.id });
      }
    }
    return Response.json({ received: true, ignored_expired_session: true });
  }

  if (event.type !== "checkout.session.completed") {
    return Response.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const stripePaymentId = session.payment_intent ? String(session.payment_intent) : session.id;
  const metadata = session.metadata ?? {};
  const amountTotal = Number(session.amount_total || 0) / 100;
  const details = session.customer_details;
  const payerEmail = details?.email ?? session.customer_email ?? null;
  const payerName = details?.name ?? null;
  const paymentKind = amountTotal === 5 ? "reservation_fee" : (metadata.payment_kind || "unknown");

  await supabaseAdmin.from("stripe_payments").upsert({
    stripe_payment_id: stripePaymentId,
    amount: amountTotal,
    currency: session.currency || "eur",
    status: session.payment_status || "paid",
    payer_name: payerName,
    payer_email: payerEmail,
    paid_at: new Date().toISOString(),
    payment_kind: paymentKind,
    monthly_charge_id: metadata.monthly_charge_id || null,
    rental_id: metadata.rental_id || null,
    metadata,
    updated_at: new Date().toISOString(),
  }, { onConflict: "stripe_payment_id" });

  // Handle class registration payments before the generic €5 early return.
  // The €5 group registration fee and €10 single lesson must update website_orders.
  if (
    (metadata.payment_kind === "reservation_fee" || metadata.payment_kind === "single_lesson") &&
    metadata.registration_id
  ) {
    const expectedAmount = metadata.payment_kind === "reservation_fee" ? 5 : 10;
    if (session.payment_status !== "paid") {
      return Response.json({ received: true, class_registration_payment_status: session.payment_status });
    }
    if (Math.abs(amountTotal - expectedAmount) > 0.01) {
      console.error("Class registration payment amount mismatch", {
        registration_id: metadata.registration_id,
        expectedAmount,
        amountTotal,
      });
      return new Response("class registration payment amount mismatch", { status: 400 });
    }
    const sourceKey = "class-registration:" + String(metadata.registration_id);
    const { data: order, error: orderLookupError } = await supabaseAdmin
      .from("website_orders")
      .select("id,raw_data,paid_text")
      .eq("source_key", sourceKey)
      .eq("order_type", "class_registration")
      .maybeSingle();
    if (orderLookupError) {
      console.error("Class registration order lookup failed", orderLookupError);
      return new Response("class registration order lookup failed", { status: 500 });
    }
    if (!order) {
      console.error("Class registration order not found", sourceKey);
      return new Response("class registration order not found", { status: 404 });
    }
    const existingRawData = order.raw_data && typeof order.raw_data === "object" ? order.raw_data : {};
    const { error: orderUpdateError } = await supabaseAdmin
      .from("website_orders")
      .update({
        paid_text: "Apmokėta",
        status: "processed",
        raw_data: {
          ...existingRawData,
          stripe_payment_id: stripePaymentId,
          stripe_checkout_session_id: session.id,
          stripe_payment_status: session.payment_status,
          // Use Stripe's original event timestamp, not webhook delivery/retry time.
          paid_at: new Date(event.created * 1000).toISOString(),
          stripe_amount_paid: amountTotal,
          payment_kind: metadata.payment_kind,
        },
      })
      .eq("id", order.id);
    if (orderUpdateError) {
      console.error("Class registration payment update failed", orderUpdateError);
      return new Response("class registration payment update failed", { status: 500 });
    }
    await autoCreateRegistrationInvoice(order.id);
    return Response.json({ received: true, class_registration_paid: true, invoice_creation_requested: true, registration_id: metadata.registration_id });
  }

  // €5 is the group reservation fee, not the one-off lesson payment.
  if (amountTotal === 5) {
    return Response.json({ received: true, reservation_fee: true });
  }

  if (metadata.payment_kind === "rental" && metadata.rental_id) {
    const { data: rental, error: rentalError } = await supabaseAdmin
      .from("studio_rentals")
      .select("id,customer_name,customer_email,customer_phone,starts_at,ends_at,price,payment_status,stripe_payment_id")
      .eq("id", metadata.rental_id)
      .maybeSingle();

    if (rentalError || !rental) return new Response("rental not found", { status: 404 });
    if (rental.stripe_payment_id === stripePaymentId || rental.payment_status === "paid") {
      await autoCreateRentalInvoice(rental.id);
      const duplicateEmail = details?.email ?? session.customer_email ?? rental.customer_email ?? null;
      const sent = await sendRentalPaidConfirmation(rental, duplicateEmail);
      if (!sent) return new Response("paid rental confirmation email failed", { status: 500 });
      return Response.json({ received: true, duplicate: true, invoice_creation_requested: true, confirmation_email_sent: true });
    }

    const paymentStatus = session.payment_status || "paid";
    if (paymentStatus !== "paid") {
      await supabaseAdmin.from("studio_rentals").update({ stripe_payment_status: paymentStatus }).eq("id", rental.id);
      return Response.json({ received: true, payment_status: paymentStatus });
    }

    const amount = Number(session.amount_total || 0) / 100;
    if (amount <= 0 || Math.abs(amount - Number(rental.price)) > 0.01) {
      return new Response("rental payment amount mismatch", { status: 400 });
    }

    const rentalDetails = session.customer_details;
    const email = rentalDetails?.email ?? session.customer_email ?? rental.customer_email ?? null;
    const phone = rentalDetails?.phone ?? rental.customer_phone ?? null;

    const { error: updateError } = await supabaseAdmin.from("studio_rentals").update({
      payment_status: "paid",
      payment_method: "stripe",
      stripe_payment_id: stripePaymentId,
      stripe_payment_status: "paid",
      // Preserve the original Stripe event date when webhooks are retried.
      paid_at: new Date(event.created * 1000).toISOString(),
      customer_email: email,
      customer_phone: phone,
    }).eq("id", rental.id);

    if (updateError) return new Response("rental update failed", { status: 500 });
    await autoCreateRentalInvoice(rental.id);
    const sent = await sendRentalPaidConfirmation(rental, email);
    if (!sent) return new Response("paid rental confirmation email failed", { status: 500 });
    return Response.json({ received: true, rental_paid: true, invoice_creation_requested: true, confirmation_email_sent: true });
  }
  if (metadata.payment_kind === "monthly_charge" && metadata.monthly_charge_id) {
    const { data: charge, error: chargeError } = await supabaseAdmin
      .from("monthly_charges")
      .select("id,student_id,amount_due,amount_paid,payer_id")
      .eq("id", metadata.monthly_charge_id)
      .maybeSingle();
    if (chargeError || !charge) return new Response("charge not found", { status: 404 });
    if (Number(charge.amount_due) <= Number(charge.amount_paid)) {
       await autoCreateInvoiceIfFullyPaid(charge.id);
       return Response.json({ received: true, already_paid: true });
     }
    const amount = Number(charge.amount_due) - Number(charge.amount_paid);
    const { data: existingPayment } = await supabaseAdmin.from("payments").select("id").eq("stripe_payment_id", stripePaymentId).maybeSingle();
    if (existingPayment) return Response.json({ received: true, duplicate: true });
    const newPaid = Number(charge.amount_paid) + amount;
    const status = newPaid >= Number(charge.amount_due) ? "paid" : "partially_paid";
    const { error: updateError } = await supabaseAdmin.from("monthly_charges").update({ amount_paid: newPaid, status, updated_at: new Date().toISOString() }).eq("id", charge.id);
    if (updateError) return new Response("charge update failed", { status: 500 });
    const { error: paymentError } = await supabaseAdmin.from("payments").insert({
      monthly_charge_id: charge.id, student_id: charge.student_id, amount,
      payment_method: "stripe", paid_at: new Date().toISOString(),
      stripe_payment_id: stripePaymentId, received_by: null,
      payer_id: metadata.payer_id || charge.payer_id || null, notes: "Stripe Checkout"
    });
    if (paymentError) return new Response("payment creation failed", { status: 500 });
         if (status === "paid") await autoCreateInvoiceIfFullyPaid(charge.id);
     return Response.json({ received: true });
  }

  if (metadata.payment_kind !== "drop_in" || !metadata.drop_in_lesson_id) {
    return Response.json({ received: true, ignored: true });
  }

  const { data: existing } = await supabaseAdmin
    .from("drop_in_bookings")
    .select("id")
    .eq("stripe_payment_id", stripePaymentId)
    .maybeSingle();

  if (existing) {
    return Response.json({ received: true, duplicate: true });
  }

  const dropInDetails = session.customer_details;
  const email = dropInDetails?.email ?? session.customer_email ?? null;
  const name = dropInDetails?.name?.trim() || "Website participant";
  const parts = name.split(/\s+/);
  const firstName = parts.shift() || "Website";
  const lastName = parts.join(" ") || "participant";
  const phone = dropInDetails?.phone ?? null;

  let studentId = metadata.student_id || null;

  if (!studentId && email) {
    const { data: existingStudent } = await supabaseAdmin
      .from("students")
      .select("id")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    studentId = existingStudent?.id ?? null;
  }

  if (!studentId) {
    const { data: newStudent, error: studentError } = await supabaseAdmin
      .from("students")
      .insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        registration_date: new Date().toISOString().slice(0, 10),
        notes: "Created automatically from a paid drop-in website booking.",
      })
      .select("id")
      .single();

    if (studentError) {
      console.error("Student creation failed:", studentError);
      return new Response("student creation failed", { status: 500 });
    }
    studentId = newStudent.id;
  }

  const { error } = await supabaseAdmin
    .from("drop_in_bookings")
    .insert({
      lesson_id: metadata.drop_in_lesson_id,
      student_id: studentId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      status: "paid",
      payment_method: "stripe",
      stripe_payment_id: stripePaymentId,
      source: "stripe",
      notes: metadata.notes ?? null,
    });

  if (error) {
    console.error("Drop-in booking creation failed:", error);
    return new Response("booking creation failed", { status: 500 });
  }

  return Response.json({ received: true });
});