require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const QRCode = require("qrcode");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const INTERNAL_ACCESS_TOKEN = process.env.INTERNAL_ACCESS_TOKEN || "";
const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY || "";
const PAYCHANGU_PUBLIC_KEY = process.env.PAYCHANGU_PUBLIC_KEY || "";
const PAYCHANGU_WEBHOOK_SECRET = process.env.PAYCHANGU_WEBHOOK_SECRET || "";

if (!INTERNAL_ACCESS_TOKEN || INTERNAL_ACCESS_TOKEN.length < 32) {
  console.error("Set INTERNAL_ACCESS_TOKEN to a random secret of at least 32 characters.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to a PostgreSQL connection string.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// Render terminates HTTPS at its proxy and forwards the client address.
// Trust the single proxy hop so express-rate-limit can identify requests safely.
app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
app.use("/api", apiLimiter);

// Record a successful, HMAC-authenticated PayChangu webhook when the verification
// endpoint itself fails. The signed event must match a pending local payment exactly.
async function recordSignedWebhookPayment(eventData) {
  const txRef = String(eventData.tx_ref || eventData.txRef || "").trim();
  if (!txRef || String(eventData.status || "").toLowerCase() !== "success") {
    throw new Error("Webhook does not contain a successful transaction reference.");
  }

  const legacy = await pool.query("SELECT * FROM payment_requests WHERE tx_ref = $1", [txRef]);
  const modern = legacy.rowCount ? { rowCount: 0, rows: [] } : await pool.query("SELECT * FROM invoice_payments WHERE tx_ref = $1", [txRef]);
  const isInvoicePayment = !legacy.rowCount && modern.rowCount > 0;
  const local = legacy.rowCount ? legacy : modern;
  if (!local.rowCount) throw new Error("Signed webhook reference does not match a local payment.");

  const payment = local.rows[0];
  if (String(eventData.currency || "").toUpperCase() !== String(payment.currency).trim().toUpperCase()
      || toMoney(eventData.amount) !== toMoney(payment.amount)) {
    throw new Error("Signed webhook amount or currency does not match the local payment.");
  }

  const expectedMode = PAYCHANGU_PUBLIC_KEY.startsWith("pub-test-") ? "test"
    : PAYCHANGU_PUBLIC_KEY.startsWith("pub-live-") ? "live" : "";
  if (expectedMode && String(eventData.mode || "").toLowerCase() !== expectedMode) {
    throw new Error("Signed webhook mode does not match the configured PayChangu key.");
  }

  const table = isInvoicePayment ? "invoice_payments" : "payment_requests";
  const receiptNumber = payment.receipt_number || ("REC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase());
  await pool.query(
    "UPDATE " + table + " SET status = 'paid', provider_reference = $2, receipt_number = COALESCE(receipt_number, $3), paid_at = COALESCE(paid_at, NOW()), updated_at = NOW(), verification_note = $4 WHERE tx_ref = $1 AND status <> 'paid'",
    [txRef, String(eventData.reference || ""), receiptNumber, "Confirmed from HMAC-authenticated PayChangu success webhook; verification endpoint unavailable."]
  );
  if (isInvoicePayment) {
    await pool.query(`UPDATE invoices SET status = CASE
      WHEN recurring_monthly THEN 'open'
      WHEN (SELECT COALESCE(SUM(amount),0) FROM invoice_payments WHERE invoice_id = invoices.id AND status = 'paid') >= total_amount THEN 'paid'
      ELSE 'partially_paid' END, updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`, [payment.invoice_id]);
  }
  return { txRef, isInvoicePayment };
}

// Keep the raw webhook body so the HMAC check uses the exact bytes PayChangu sent.
app.post("/api/paychangu/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  try {
    if (!PAYCHANGU_WEBHOOK_SECRET) return res.status(503).send("Webhook secret is not configured.");
    const signature = req.get("Signature") || req.get("signature") || "";
    const expected = crypto.createHmac("sha256", PAYCHANGU_WEBHOOK_SECRET).update(req.body).digest("hex");
    const suppliedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
      return res.status(401).send("Invalid signature.");
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    const eventData = payload.data || payload;
    const txRef = String(eventData.tx_ref || eventData.txRef || "").trim();
    if (!txRef) return res.status(400).send("Missing transaction reference.");

    try {
      const verified = await verifyAndUpdatePayment(txRef);
      if (verified.found && verified.status === "success") return res.sendStatus(200);
      if (verified.found && ["failed", "cancelled", "canceled"].includes(String(verified.status || "").toLowerCase())) return res.sendStatus(200);
      throw new Error("Provider verification did not confirm a final successful status.");
    } catch (verificationError) {
      console.error("PayChangu API verification failed for signed webhook; checking signed event:", verificationError.message);
      const recorded = await recordSignedWebhookPayment(eventData);
      console.warn("Payment recorded from signed PayChangu webhook fallback:", recorded.txRef);
      return res.sendStatus(200);
    }
  } catch (error) {
    console.error("PayChangu webhook error:", error.message);
    return res.sendStatus(500);
  }
});

app.use(express.json({ limit: "32kb" }));

function safeTokenEqual(candidate) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(INTERNAL_ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireInternalAccess(req, res, next) {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeTokenEqual(token)) return res.status(401).json({ error: "Internal access required." });
  next();
}

function makeReference() {
  return "TP-" + crypto.randomUUID().replace(/-/g, "").slice(0, 18).toUpperCase();
}

 // Inline checkout references are numeric because PayChangu's inline popup example
 // and verification endpoint expect a numeric transaction reference.
async function makeInvoicePaymentReference() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = String(crypto.randomInt(1, 1000000000));
    const existing = await pool.query(
      "SELECT 1 FROM invoice_payments WHERE tx_ref = $1 UNION ALL SELECT 1 FROM payment_requests WHERE tx_ref = $1 LIMIT 1",
      [ref]
    );
    if (!existing.rowCount) return ref;
  }
  throw new Error("Could not allocate a unique PayChangu invoice reference.");
}

function toMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) / 100;
}

async function verifyAndUpdatePayment(txRef) {
  if (!PAYCHANGU_SECRET_KEY) throw new Error("PayChangu secret key is not configured.");
  const legacy = await pool.query("SELECT * FROM payment_requests WHERE tx_ref = $1", [txRef]);
  const modern = legacy.rowCount ? { rowCount: 0, rows: [] } : await pool.query("SELECT * FROM invoice_payments WHERE tx_ref = $1", [txRef]);
  const isInvoicePayment = !legacy.rowCount && modern.rowCount > 0;
  const local = legacy.rowCount ? legacy : modern;
  if (!local.rowCount) return { found: false };

  const response = await fetch("https://api.paychangu.com/verify-payment/" + encodeURIComponent(txRef), {
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + PAYCHANGU_SECRET_KEY },
    signal: AbortSignal.timeout(15000)
  });
  const responseText = await response.text();
  if (!response.ok) {
    // Log the provider's diagnostic response (never log credentials) so HTTP 400s can be diagnosed.
    console.error("PayChangu verification rejected request:", response.status, responseText.slice(0, 500));
    throw new Error("PayChangu verification returned HTTP " + response.status);
  }
  let result;
  try { result = JSON.parse(responseText); }
  catch { throw new Error("PayChangu verification returned invalid JSON."); }
  const data = result.data || {};
  const localPayment = local.rows[0];
  const matches = String(data.tx_ref || "") === txRef
    && String(data.currency || "").toUpperCase() === localPayment.currency
    && toMoney(data.amount) === toMoney(localPayment.amount);

  if (!matches) {
    const table = isInvoicePayment ? "invoice_payments" : "payment_requests";
    await pool.query("UPDATE " + table + " SET verification_note = $2, updated_at = NOW() WHERE tx_ref = $1",
      [txRef, "Verification details did not match the expected reference, currency, and amount."]);
    throw new Error("Verified payment details did not match the local request.");
  }

  const providerStatus = String(data.status || "").toLowerCase();
  if (providerStatus === "success") {
    const receiptNumber = localPayment.receipt_number || ("REC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase());
    const table = isInvoicePayment ? "invoice_payments" : "payment_requests";
    await pool.query(
      "UPDATE " + table + " SET status = 'paid', provider_reference = $2, receipt_number = COALESCE(receipt_number, $3), paid_at = COALESCE(paid_at, NOW()), updated_at = NOW(), verification_note = NULL WHERE tx_ref = $1 AND status <> 'paid'",
      [txRef, String(data.reference || ""), receiptNumber]
    );
    if (isInvoicePayment) {
      await pool.query(`UPDATE invoices SET status = CASE
        WHEN recurring_monthly THEN 'open'
        WHEN (SELECT COALESCE(SUM(amount),0) FROM invoice_payments WHERE invoice_id = invoices.id AND status = 'paid') >= total_amount THEN 'paid'
        ELSE 'partially_paid' END, updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`, [localPayment.invoice_id]);
    }
  } else if (["failed", "cancelled", "canceled"].includes(providerStatus)) {
    const table = isInvoicePayment ? "invoice_payments" : "payment_requests";
    await pool.query("UPDATE " + table + " SET status = $2, updated_at = NOW() WHERE tx_ref = $1 AND status NOT IN ('paid', 'cancelled')",
      [txRef, providerStatus === "failed" ? "failed" : "cancelled"]);
  }
  return { found: true, status: providerStatus };
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id UUID PRIMARY KEY,
      tx_ref TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      currency CHAR(3) NOT NULL DEFAULT 'MWK',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
      checkout_url TEXT,
      provider_reference TEXT,
      receipt_number TEXT UNIQUE,
      verification_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS payment_requests_created_at_idx ON payment_requests (created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS payment_requests_status_idx ON payment_requests (status)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
      currency CHAR(3) NOT NULL DEFAULT 'MWK',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_paid','paid','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      due_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id UUID PRIMARY KEY,
      invoice_id UUID NOT NULL REFERENCES invoices(id),
      tx_ref TEXT NOT NULL UNIQUE,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      currency CHAR(3) NOT NULL DEFAULT 'MWK',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
      checkout_url TEXT,
      provider_reference TEXT,
      receipt_number TEXT UNIQUE,
      verification_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS invoices_created_at_idx ON invoices (created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS invoice_payments_invoice_id_idx ON invoice_payments (invoice_id, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS invoice_payments_status_idx ON invoice_payments (status)");
  await pool.query("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurring_monthly BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_start_date DATE");
  await pool.query("ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS period_key TEXT");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_invoice_period_paid_idx ON invoice_payments (invoice_id, period_key) WHERE status = 'paid' AND period_key IS NOT NULL");
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "tambala-pay", mode: process.env.NODE_ENV || "development" });
});

// Public invoice page: the UUID in the URL is an unguessable share token.
app.get("/invoice/:id", (req, res) => res.sendFile(path.join(__dirname, "public", "invoice.html")));

app.get("/api/public/invoices/:id", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT i.id, i.invoice_number, i.description, i.customer_name, i.total_amount, i.currency,
        i.status, i.created_at, i.due_at, i.recurring_monthly, i.billing_start_date,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid' AND p.period_key IS NULL), 0)::numeric(12,2) AS paid_amount,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0), 0)::numeric(12,2) AS balance_due
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.id = $1 GROUP BY i.id
    `, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Invoice not found." });
    const payments = await pool.query(
      "SELECT id, amount, currency, status, receipt_number, created_at, paid_at, period_key FROM invoice_payments WHERE invoice_id = $1 AND status = 'paid' ORDER BY paid_at DESC",
      [req.params.id]
    );
    const pendingPeriods = await pool.query("SELECT period_key FROM invoice_payments WHERE invoice_id = $1 AND period_key IS NOT NULL AND status = 'pending'", [req.params.id]);
    const periods = [];
    if (result.rows[0].recurring_monthly && result.rows[0].billing_start_date) {
      const start = new Date(String(result.rows[0].billing_start_date).slice(0,10) + "T00:00:00Z");
      const now = new Date();
      const count = Math.max(12, (now.getUTCFullYear()-start.getUTCFullYear())*12 + now.getUTCMonth()-start.getUTCMonth() + 2);
      const paid = new Set(payments.rows.map(p => p.period_key).filter(Boolean));
      const pending = new Set(pendingPeriods.rows.map(p => p.period_key));
      for (let n=0; n<Math.min(count,120); n++) {
        const d = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+n,1));
        const key = d.getUTCFullYear()+"-"+String(d.getUTCMonth()+1).padStart(2,"0");
        periods.push({period_key:key,label:d.toLocaleDateString("en",{month:"long",year:"numeric",timeZone:"UTC"}),status:paid.has(key)?"paid":pending.has(key)?"pending":d>new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1))?"upcoming":"due"});
      }
    }
    res.set("Cache-Control", "no-store");
    res.json({ invoice: result.rows[0], payments: payments.rows, periods });
  } catch (error) { next(error); }
});

// Verify a payment after PayChangu redirects the customer back to their invoice.
// The reference must belong to this invoice, and success is confirmed server-side with PayChangu.
app.post("/api/public/invoices/:id/verify-payment", async (req, res, next) => {
  try {
    const txRef = String(req.body.tx_ref || "").trim().slice(0, 80);
    if (!txRef) return res.status(400).json({ error: "Missing payment reference." });
    const local = await pool.query(
      "SELECT id FROM invoice_payments WHERE invoice_id = $1 AND tx_ref = $2",
      [req.params.id, txRef]
    );
    if (!local.rowCount) return res.status(404).json({ error: "Payment reference was not found for this invoice." });
    const verified = await verifyAndUpdatePayment(txRef);
    if (!verified.found) return res.status(404).json({ error: "Payment record was not found." });
    res.set("Cache-Control", "no-store");
    return res.json({ status: verified.status || "pending" });
  } catch (error) { next(error); }
});

app.post("/api/public/invoices/:id/periods/:period/payments", async (req, res, next) => {
  try {
    if (!PAYCHANGU_SECRET_KEY || !PAYCHANGU_PUBLIC_KEY) return res.status(503).json({ error: "Online checkout is not configured yet." });
    if (process.env.NODE_ENV === "production" && !APP_BASE_URL.startsWith("https://")) return res.status(500).json({ error: "Payment service configuration error." });
    const period = String(req.params.period || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: "Choose a valid billing month." });
    const email = String(req.body.email || "").trim().slice(0,254);
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address for the receipt." });
    const found = await pool.query("SELECT * FROM invoices WHERE id=$1 AND recurring_monthly=TRUE AND status <> 'cancelled'", [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: "Monthly invoice not found or no longer active." });
    const invoice = found.rows[0];
    const start = new Date(String(invoice.billing_start_date).slice(0,10)+"T00:00:00Z");
    const chosen = new Date(period+"-01T00:00:00Z");
    if (chosen < new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1))) return res.status(400).json({ error: "This billing period is before the contract start date." });
    if (chosen > new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth()+1,1))) return res.status(400).json({ error: "This billing period is not available yet." });
    const existing = await pool.query("SELECT id,status,checkout_url FROM invoice_payments WHERE invoice_id=$1 AND period_key=$2 ORDER BY created_at DESC LIMIT 1", [invoice.id,period]);
    if (existing.rowCount && existing.rows[0].status === "paid") return res.status(409).json({ error: "This month is already marked as paid." });
    if (existing.rowCount && existing.rows[0].status === "pending") return res.status(409).json({ error: "A checkout for this month is already pending. Complete it or contact the business before retrying." });
    const id = crypto.randomUUID();
    const txRef = await makeInvoicePaymentReference();
    const amount = toMoney(invoice.total_amount);
    await pool.query("INSERT INTO invoice_payments (id,invoice_id,tx_ref,amount,period_key) VALUES ($1,$2,$3,$4,$5)",[id,invoice.id,txRef,amount,period]);
    const customerParts = String(invoice.customer_name || "Customer").trim().split(/\\s+/);
    const invoiceUrl = APP_BASE_URL + "/invoice/" + encodeURIComponent(invoice.id) + "?payment=checking";
    res.status(201).json({ payment: { id, tx_ref:txRef, amount, currency:invoice.currency || "MWK", checkout: {
      public_key:PAYCHANGU_PUBLIC_KEY,tx_ref:txRef,amount,currency:invoice.currency || "MWK",
      callback_url:invoiceUrl,return_url:invoiceUrl,
      customer:{email,first_name:customerParts[0] || "Customer",last_name:customerParts.slice(1).join(" ")},
      customization:{title:"Tambala Pay",description:invoice.invoice_number+" — "+period+" monthly payment"},
      meta:{invoice_id:invoice.id,invoice_number:invoice.invoice_number,payment_id:id,billing_period:period}
    }}});
  } catch(error) { next(error); }
});

app.post("/api/public/invoices/:id/payments", async (req, res, next) => {
  try {
    if (!PAYCHANGU_SECRET_KEY) return res.status(503).json({ error: "Online checkout is not configured yet. Please contact the business that issued this invoice." });
    if (!PAYCHANGU_PUBLIC_KEY) return res.status(503).json({ error: "The secure checkout popup is not configured yet. Please contact the business that issued this invoice." });
    if (process.env.NODE_ENV === "production" && !APP_BASE_URL.startsWith("https://")) return res.status(500).json({ error: "Payment service configuration error." });
    const amount = toMoney(req.body.amount);
    const email = String(req.body.email || "").trim().slice(0, 254);
    if (amount === null || amount < 1 || amount > 100000000) return res.status(400).json({ error: "Enter a valid payment amount." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address for the payment receipt." });

    const result = await pool.query(`
      SELECT i.*,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0), 0)::numeric(12,2) AS balance_due,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('paid','pending')), 0), 0)::numeric(12,2) AS available_amount
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.id = $1 GROUP BY i.id
    `, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Invoice not found." });
    const invoice = result.rows[0];
    if (invoice.status === "cancelled" || invoice.status === "paid") return res.status(409).json({ error: "This invoice is not open for payment." });
    if (amount > toMoney(invoice.available_amount)) return res.status(400).json({ error: "That amount exceeds the available balance. Refresh the invoice and try again." });

    const id = crypto.randomUUID();
    const txRef = await makeInvoicePaymentReference();
    await pool.query("INSERT INTO invoice_payments (id, invoice_id, tx_ref, amount) VALUES ($1,$2,$3,$4)", [id, invoice.id, txRef, amount]);
    const customerParts = String(invoice.customer_name || "Customer").trim().split(/\s+/);
    const invoiceUrl = APP_BASE_URL + "/invoice/" + encodeURIComponent(invoice.id) + "?payment=checking";
    res.status(201).json({
      payment: {
        id, tx_ref: txRef, amount, currency: invoice.currency || "MWK",
        checkout: {
          public_key: PAYCHANGU_PUBLIC_KEY,
          tx_ref: txRef,
          amount,
          currency: invoice.currency || "MWK",
          callback_url: invoiceUrl,
          return_url: invoiceUrl,
          customer: {
            email,
            first_name: customerParts[0] || "Customer",
            last_name: customerParts.slice(1).join(" ")
          },
          customization: { title: "Tambala Pay", description: invoice.invoice_number + " — " + invoice.description },
          meta: { invoice_id: invoice.id, invoice_number: invoice.invoice_number, payment_id: id }
        }
      }
    });
  } catch (error) { next(error); }
});

app.get("/api/public/invoices/:id/qr", async (req, res, next) => {
  try {
    const result = await pool.query("SELECT id FROM invoices WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Invoice not found." });
    const invoiceUrl = APP_BASE_URL + "/invoice/" + encodeURIComponent(req.params.id);
    const qrDataUrl = await QRCode.toDataURL(invoiceUrl, { errorCorrectionLevel: "M", margin: 2, width: 360 });
    res.set("Cache-Control", "no-store");
    res.json({ url: invoiceUrl, qr_data_url: qrDataUrl });
  } catch (error) { next(error); }
});

app.get("/api/public/payments/:id/receipt", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT p.tx_ref, i.invoice_number, i.description, i.customer_name, p.amount, p.currency,
        p.status, p.receipt_number, p.provider_reference, p.paid_at
      FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = $1
    `, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Payment not found." });
    if (result.rows[0].status !== "paid" || !result.rows[0].receipt_number) return res.status(409).json({ error: "Receipt is available after the payment is verified." });
    res.set("Cache-Control", "no-store");
    res.json({ receipt: result.rows[0] });
  } catch (error) { next(error); }
});

// Invoices are created once; each payment attempt is a separate, auditable record.
app.get("/api/invoices", requireInternalAccess, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT i.id, i.invoice_number, i.description, i.customer_name, i.customer_email,
        i.total_amount, i.currency, i.status, i.created_at, i.due_at, i.recurring_monthly, i.billing_start_date,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric(12,2) AS paid_amount,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0), 0)::numeric(12,2) AS balance_due
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      GROUP BY i.id ORDER BY i.created_at DESC LIMIT 250
    `);
    res.json({ invoices: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/invoices", requireInternalAccess, async (req, res, next) => {
  try {
    const description = String(req.body.description || "").trim().slice(0, 180);
    const customerName = String(req.body.customerName || "").trim().slice(0, 100);
    const customerEmail = String(req.body.customerEmail || "").trim().slice(0, 254);
    const totalAmount = toMoney(req.body.totalAmount);
    const recurringMonthly = req.body.recurringMonthly === true;
    const billingStartDate = String(req.body.billingStartDate || "").trim();
    if (recurringMonthly && !/^\d{4}-\d{2}-\d{2}$/.test(billingStartDate)) return res.status(400).json({ error: "Choose a valid monthly billing start date." });
    if (!description) return res.status(400).json({ error: "Invoice description is required." });
    if (totalAmount === null || totalAmount < 1 || totalAmount > 100000000) return res.status(400).json({ error: "Enter an invoice total between MWK 1 and MWK 100,000,000." });
    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ error: "Enter a valid customer email address." });
    const id = crypto.randomUUID();
    const invoiceNumber = "INV-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const result = await pool.query(
      "INSERT INTO invoices (id, invoice_number, description, customer_name, customer_email, total_amount, recurring_monthly, billing_start_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [id, invoiceNumber, description, customerName || null, customerEmail || null, totalAmount, recurringMonthly, recurringMonthly ? billingStartDate : null]
    );
    res.status(201).json({ invoice: { ...result.rows[0], paid_amount: "0.00", balance_due: String(totalAmount), recurring_monthly: recurringMonthly } });
  } catch (error) { next(error); }
});

app.get("/api/invoices/:id", requireInternalAccess, async (req, res, next) => {
  try {
    const invoice = await pool.query(`
      SELECT i.id, i.invoice_number, i.description, i.customer_name, i.customer_email,
        i.total_amount, i.currency, i.status, i.created_at, i.due_at, i.recurring_monthly, i.billing_start_date,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric(12,2) AS paid_amount,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0), 0)::numeric(12,2) AS balance_due
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.id = $1 GROUP BY i.id
    `, [req.params.id]);
    if (!invoice.rowCount) return res.status(404).json({ error: "Invoice not found." });
    const payments = await pool.query("SELECT id, tx_ref, amount, currency, status, checkout_url, receipt_number, created_at, paid_at, period_key FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at DESC", [req.params.id]);
    res.json({ invoice: invoice.rows[0], payments: payments.rows });
  } catch (error) { next(error); }
});

app.post("/api/invoices/:id/payments", requireInternalAccess, async (req, res, next) => {
  try {
    if (!PAYCHANGU_SECRET_KEY) return res.status(503).json({ error: "PayChangu is not configured yet. Add test credentials to the server environment." });
    if (!APP_BASE_URL.startsWith("https://") && process.env.NODE_ENV === "production") return res.status(500).json({ error: "APP_BASE_URL must use HTTPS in production." });
    const amount = toMoney(req.body.amount);
    if (amount === null || amount < 1 || amount > 100000000) return res.status(400).json({ error: "Enter a valid payment amount." });
    const invoiceResult = await pool.query(`
      SELECT i.*,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0), 0)::numeric(12,2) AS balance_due,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('paid','pending')), 0), 0)::numeric(12,2) AS available_amount
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.id = $1 GROUP BY i.id
    `, [req.params.id]);
    if (!invoiceResult.rowCount) return res.status(404).json({ error: "Invoice not found." });
    const invoice = invoiceResult.rows[0];
    if (invoice.status === "cancelled" || invoice.status === "paid") return res.status(409).json({ error: "This invoice is not open for payment." });
    if (amount > toMoney(invoice.available_amount)) return res.status(400).json({ error: "Payment exceeds the amount currently available to collect (MWK " + invoice.available_amount + "). Any existing pending checkout temporarily reserves its amount." });

    const id = crypto.randomUUID();
    const txRef = makeReference();
    await pool.query("INSERT INTO invoice_payments (id, invoice_id, tx_ref, amount) VALUES ($1,$2,$3,$4)", [id, invoice.id, txRef, amount]);
    try {
      const payload = {
        amount: String(amount), currency: "MWK", tx_ref: txRef,
        first_name: String(invoice.customer_name || "Customer").trim().split(/\s+/)[0] || "Customer",
        last_name: String(invoice.customer_name || "").trim().split(/\s+/).slice(1).join(" "),
        email: invoice.customer_email || undefined,
        callback_url: APP_BASE_URL + "/api/paychangu/webhook",
        return_url: APP_BASE_URL + "/?payment=cancelled",
        customization: { title: "Tambala Pay", description: invoice.invoice_number + " — " + invoice.description }
      };
      const providerResponse = await fetch("https://api.paychangu.com/payment", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + PAYCHANGU_SECRET_KEY },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
      });
      const providerResult = await providerResponse.json().catch(() => ({}));
      const checkoutUrl = providerResult.data && providerResult.data.checkout_url;
      if (!providerResponse.ok || providerResult.status !== "success" || !checkoutUrl || !checkoutUrl.startsWith("https://")) {
        await pool.query("UPDATE invoice_payments SET status = 'failed', verification_note = $2, updated_at = NOW() WHERE tx_ref = $1", [txRef, "Could not initialize PayChangu checkout."]);
        return res.status(502).json({ error: "PayChangu could not create checkout. Check the API key and account mode." });
      }
      await pool.query("UPDATE invoice_payments SET checkout_url = $2, updated_at = NOW() WHERE tx_ref = $1", [txRef, checkoutUrl]);
      const qrDataUrl = await QRCode.toDataURL(checkoutUrl, { errorCorrectionLevel: "M", margin: 2, width: 360 });
      res.status(201).json({ payment: { id, tx_ref: txRef, amount, currency: "MWK", status: "pending", checkout_url: checkoutUrl, qr_data_url: qrDataUrl } });
    } catch (providerError) {
      await pool.query("UPDATE invoice_payments SET status = 'failed', verification_note = $2, updated_at = NOW() WHERE tx_ref = $1", [txRef, "PayChangu connection failed."]);
      throw providerError;
    }
  } catch (error) { next(error); }
});

// Organization API: look up one payment by its transaction reference across
// invoice payments and legacy one-off payment requests. Never treat pending as paid.
app.get("/api/payments/:txRef", requireInternalAccess, async (req, res, next) => {
  try {
    const txRef = String(req.params.txRef || "").trim().slice(0, 100);
    if (!txRef) return res.status(400).json({ error: "Transaction reference is required." });

    const invoicePayment = await pool.query(`
      SELECT p.id, p.tx_ref, p.invoice_id, i.invoice_number, i.description,
        i.customer_name, p.amount, p.currency, p.status, p.checkout_url,
        p.provider_reference, p.receipt_number, p.created_at, p.updated_at, p.paid_at
      FROM invoice_payments p
      JOIN invoices i ON i.id = p.invoice_id
      WHERE p.tx_ref = $1
      LIMIT 1
    `, [txRef]);

    if (invoicePayment.rowCount) {
      res.set("Cache-Control", "no-store");
      return res.json({ payment: { ...invoicePayment.rows[0], kind: "invoice_payment" } });
    }

    const requestPayment = await pool.query(
      `SELECT id, tx_ref, description, customer_name, customer_email, amount,
        currency, status, checkout_url, provider_reference, receipt_number,
        created_at, updated_at, paid_at
       FROM payment_requests WHERE tx_ref = $1 LIMIT 1`,
      [txRef]
    );
    if (!requestPayment.rowCount) return res.status(404).json({ error: "Payment not found." });
    res.set("Cache-Control", "no-store");
    return res.json({ payment: { ...requestPayment.rows[0], kind: "payment_request" } });
  } catch (error) { next(error); }
});

app.get("/api/summary", requireInternalAccess, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        ((SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM payment_requests))::int AS total_requests,
        ((SELECT COUNT(*) FROM invoice_payments WHERE status = 'paid') + (SELECT COUNT(*) FROM payment_requests WHERE status = 'paid'))::int AS successful_payments,
        ((SELECT COUNT(*) FROM invoice_payments WHERE status = 'pending') + (SELECT COUNT(*) FROM payment_requests WHERE status = 'pending'))::int AS pending_payments,
        ((SELECT COUNT(*) FROM invoice_payments WHERE status = 'failed') + (SELECT COUNT(*) FROM payment_requests WHERE status = 'failed'))::int AS failed_payments,
        ((SELECT COALESCE(SUM(amount),0) FROM invoice_payments WHERE status = 'paid') + (SELECT COALESCE(SUM(amount),0) FROM payment_requests WHERE status = 'paid'))::numeric(12,2) AS collected_mwk,
        ((SELECT COALESCE(SUM(amount),0) FROM invoice_payments WHERE status = 'pending') + (SELECT COALESCE(SUM(amount),0) FROM payment_requests WHERE status = 'pending'))::numeric(12,2) AS pending_mwk
    `);
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.get("/api/requests", requireInternalAccess, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || "100", 10) || 100, 1), 250);
    const result = await pool.query(
      "SELECT id, tx_ref, description, customer_name, customer_email, amount, currency, status, checkout_url, provider_reference, receipt_number, created_at, updated_at, paid_at FROM payment_requests ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    res.json({ requests: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/requests", requireInternalAccess, async (req, res, next) => {
  try {
    if (!PAYCHANGU_SECRET_KEY) {
      return res.status(503).json({ error: "PayChangu is not configured yet. Add your test secret key to the server environment first." });
    }
    const description = String(req.body.description || "").trim().slice(0, 180);
    const customerName = String(req.body.customerName || "").trim().slice(0, 100);
    const customerEmail = String(req.body.customerEmail || "").trim().slice(0, 254);
    const amount = toMoney(req.body.amount);
    if (!description) return res.status(400).json({ error: "Description is required." });
    if (amount === null || amount < 1 || amount > 100000000) return res.status(400).json({ error: "Enter a valid amount between MWK 1 and MWK 100,000,000." });
    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ error: "Enter a valid customer email address." });
    if (!APP_BASE_URL.startsWith("https://") && process.env.NODE_ENV === "production") {
      return res.status(500).json({ error: "APP_BASE_URL must use HTTPS in production." });
    }

    const id = crypto.randomUUID();
    const txRef = makeReference();
    await pool.query(
      "INSERT INTO payment_requests (id, tx_ref, description, customer_name, customer_email, amount, currency, status) VALUES ($1,$2,$3,$4,$5,$6,'MWK','pending')",
      [id, txRef, description, customerName || null, customerEmail || null, amount]
    );

    try {
      const payload = {
        amount: String(amount),
        currency: "MWK",
        tx_ref: txRef,
        first_name: customerName.split(/\s+/)[0] || "Customer",
        last_name: customerName.split(/\s+/).slice(1).join(" "),
        email: customerEmail || undefined,
        callback_url: APP_BASE_URL + "/api/paychangu/webhook",
        return_url: APP_BASE_URL + "/?payment=cancelled",
        customization: { title: "Tambala Pay", description }
      };
      const providerResponse = await fetch("https://api.paychangu.com/payment", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer " + PAYCHANGU_SECRET_KEY
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000)
      });
      const providerResult = await providerResponse.json().catch(() => ({}));
      const checkoutUrl = providerResult.data && providerResult.data.checkout_url;
      if (!providerResponse.ok || providerResult.status !== "success" || !checkoutUrl || !checkoutUrl.startsWith("https://")) {
        await pool.query("UPDATE payment_requests SET status = 'failed', verification_note = $2, updated_at = NOW() WHERE tx_ref = $1", [txRef, "Could not initialize PayChangu checkout."]);
        return res.status(502).json({ error: "PayChangu could not create a checkout session. Check your API key and account mode." });
      }
      await pool.query("UPDATE payment_requests SET checkout_url = $2, updated_at = NOW() WHERE tx_ref = $1", [txRef, checkoutUrl]);
      const created = await pool.query("SELECT id, tx_ref, description, customer_name, customer_email, amount, currency, status, checkout_url, created_at FROM payment_requests WHERE tx_ref = $1", [txRef]);
      res.status(201).json({ request: created.rows[0] });
    } catch (providerError) {
      await pool.query("UPDATE payment_requests SET status = 'failed', verification_note = $2, updated_at = NOW() WHERE tx_ref = $1", [txRef, "PayChangu connection failed."]);
      throw providerError;
    }
  } catch (error) { next(error); }
});

app.get("/api/paychangu/return", async (req, res) => {
  const txRef = String(req.query.tx_ref || "").slice(0, 80);
  let outcome = "checking";
  if (txRef) {
    try {
      const result = await verifyAndUpdatePayment(txRef);
      outcome = result.status === "success" ? "success" : (["failed", "cancelled", "canceled"].includes(result.status) ? "failed" : "checking");
    } catch (error) {
      console.error("Return verification error:", error.message);
    }
  }
  res.redirect("/?payment=" + encodeURIComponent(outcome));
});

app.get("/api/invoice-payments/:id/receipt", requireInternalAccess, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT p.tx_ref, i.invoice_number || ' — ' || i.description AS description,
        i.customer_name, i.customer_email, p.amount, p.currency, p.status,
        p.receipt_number, p.provider_reference, p.paid_at
      FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Payment not found." });
    if (result.rows[0].status !== "paid" || !result.rows[0].receipt_number) {
      return res.status(409).json({ error: "A receipt is available only after the payment is verified as successful." });
    }
    res.json({ receipt: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/requests/:id/receipt", requireInternalAccess, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT tx_ref, description, customer_name, customer_email, amount, currency, status, receipt_number, provider_reference, paid_at FROM payment_requests WHERE id = $1",
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Payment request not found." });
    if (result.rows[0].status !== "paid" || !result.rows[0].receipt_number) {
      return res.status(409).json({ error: "A receipt is available only after the payment is verified as successful." });
    }
    res.json({ receipt: result.rows[0] });
  } catch (error) { next(error); }
});


/**
 * Stateless MCP endpoint. One authenticated URL exposes the organization-safe
 * Tambala Pay operations as Model Context Protocol tools.
 */
const MCP_TOOLS = [
  { name: "get_payment_summary", description: "Get aggregate payment counts and MWK totals.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_invoices", description: "List the latest invoices (up to 250).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "create_invoice", description: "Create a one-time or recurring monthly invoice in MWK. For monthly contracts set recurringMonthly=true and billingStartDate=YYYY-MM-DD; totalAmount becomes the monthly fee.", inputSchema: { type: "object", properties: { description: { type: "string", maxLength: 180 }, customerName: { type: "string", maxLength: 100 }, customerEmail: { type: "string", format: "email" }, totalAmount: { type: "number", minimum: 1, maximum: 100000000 }, recurringMonthly: { type: "boolean" }, billingStartDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, required: ["description", "totalAmount"], additionalProperties: false } },
  { name: "get_invoice", description: "Get an invoice and its payment attempts by invoice UUID.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "create_invoice_payment", description: "Create a partial-payment checkout for an invoice. This creates a pending attempt, not a confirmed payment.", inputSchema: { type: "object", properties: { id: { type: "string" }, amount: { type: "number", minimum: 1, maximum: 100000000 } }, required: ["id", "amount"], additionalProperties: false } },
  { name: "get_payment", description: "Look up a payment using its exact transaction reference.", inputSchema: { type: "object", properties: { txRef: { type: "string", maxLength: 100 } }, required: ["txRef"], additionalProperties: false } },
  { name: "list_payment_requests", description: "List legacy one-off payment requests. Limit defaults to 100 and is capped at 250.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 250 } }, additionalProperties: false } },
  { name: "create_payment_request", description: "Create a one-off MWK payment request and PayChangu checkout.", inputSchema: { type: "object", properties: { description: { type: "string", maxLength: 180 }, customerName: { type: "string", maxLength: 100 }, customerEmail: { type: "string", format: "email" }, amount: { type: "number", minimum: 1, maximum: 100000000 } }, required: ["description", "amount"], additionalProperties: false } },
  { name: "get_invoice_payment_receipt", description: "Retrieve a receipt for a verified invoice payment using its payment UUID.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "get_payment_request_receipt", description: "Retrieve a receipt for a verified one-off payment request using its request UUID.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }
];

app.post("/mcp", requireInternalAccess, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const rpc = req.body || {};
  const reply = (result) => res.json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
  const fail = (code, message) => res.json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return fail(-32600, "Invalid JSON-RPC request.");
  if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") return res.sendStatus(202);
  if (rpc.method === "initialize") {
    return reply({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tambala-pay", version: "1.0.0" },
      instructions: "Use tools for Tambala Pay invoices and payment records. A pending payment is not proof of collection; only server-verified paid status confirms payment."
    });
  }
  if (rpc.method === "ping") return reply({});
  if (rpc.method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (rpc.method !== "tools/call") return fail(-32601, "Method not found.");
  const params = rpc.params || {};
  const args = params.arguments || {};
  const routes = {
    get_payment_summary: ["GET", "/api/summary"],
    list_invoices: ["GET", "/api/invoices"],
    create_invoice: ["POST", "/api/invoices", args],
    get_invoice: ["GET", "/api/invoices/" + encodeURIComponent(args.id || "")],
    create_invoice_payment: ["POST", "/api/invoices/" + encodeURIComponent(args.id || "") + "/payments", { amount: args.amount }],
    get_payment: ["GET", "/api/payments/" + encodeURIComponent(args.txRef || "")],
    list_payment_requests: ["GET", "/api/requests?limit=" + encodeURIComponent(args.limit || 100)],
    create_payment_request: ["POST", "/api/requests", args],
    get_invoice_payment_receipt: ["GET", "/api/invoice-payments/" + encodeURIComponent(args.id || "") + "/receipt"],
    get_payment_request_receipt: ["GET", "/api/requests/" + encodeURIComponent(args.id || "") + "/receipt"]
  };
  const selected = routes[params.name];
  if (!selected) return fail(-32602, "Unknown tool name.");
  if ((params.name === "get_invoice" || params.name === "create_invoice_payment" || params.name.endsWith("_receipt")) && !args.id) return fail(-32602, "The id argument is required.");
  if (params.name === "get_payment" && !args.txRef) return fail(-32602, "The txRef argument is required.");
  if (params.name === "create_invoice" && (!String(args.description || "").trim() || !Number.isFinite(Number(args.totalAmount)))) return fail(-32602, "description and numeric totalAmount are required.");
  if (params.name === "create_invoice_payment" && !Number.isFinite(Number(args.amount))) return fail(-32602, "A numeric amount is required.");
  if (params.name === "create_payment_request" && (!String(args.description || "").trim() || !Number.isFinite(Number(args.amount)))) return fail(-32602, "description and numeric amount are required.");
  try {
    const method = selected[0];
    const target = "http://127.0.0.1:" + PORT + selected[1];
    const response = await fetch(target, {
      method,
      headers: { Authorization: "Bearer " + INTERNAL_ACCESS_TOKEN, ...(selected[2] ? { "Content-Type": "application/json" } : {}) },
      ...(selected[2] ? { body: JSON.stringify(selected[2]) } : {}),
      signal: AbortSignal.timeout(25000)
    });
    const payload = await response.json().catch(() => ({ error: "The API returned a non-JSON response." }));
    if (!response.ok) return reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ status: response.status, ...payload }) }] });
    return reply({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  } catch (error) {
    return reply({ isError: true, content: [{ type: "text", text: "Tool execution failed: " + error.message }] });
  }
});

app.use((error, req, res, next) => {
  console.error("Request error:", error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Something went wrong. Check the server logs for details." });
});

async function start() {
  await initializeDatabase();
  app.listen(PORT, () => console.log("Tambala Pay listening on port " + PORT));
}
start().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
