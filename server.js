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

// Keep the raw webhook body so the HMAC check uses the bytes PayChangu sent.
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
    const txRef = String(eventData.tx_ref || eventData.txRef || eventData.reference || "");
    if (txRef) await verifyAndUpdatePayment(txRef);
    return res.sendStatus(200);
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
  if (!response.ok) throw new Error("PayChangu verification returned HTTP " + response.status);
  const result = await response.json();
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
        i.status, i.created_at, i.due_at,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric(12,2) AS paid_amount,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0), 0)::numeric(12,2) AS balance_due
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.id = $1 GROUP BY i.id
    `, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Invoice not found." });
    const payments = await pool.query(
      "SELECT id, amount, currency, status, receipt_number, created_at, paid_at FROM invoice_payments WHERE invoice_id = $1 AND status = 'paid' ORDER BY paid_at DESC",
      [req.params.id]
    );
    res.set("Cache-Control", "no-store");
    res.json({ invoice: result.rows[0], payments: payments.rows });
  } catch (error) { next(error); }
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
    const txRef = makeReference();
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
        i.total_amount, i.currency, i.status, i.created_at, i.due_at,
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
    if (!description) return res.status(400).json({ error: "Invoice description is required." });
    if (totalAmount === null || totalAmount < 1 || totalAmount > 100000000) return res.status(400).json({ error: "Enter an invoice total between MWK 1 and MWK 100,000,000." });
    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ error: "Enter a valid customer email address." });
    const id = crypto.randomUUID();
    const invoiceNumber = "INV-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const result = await pool.query(
      "INSERT INTO invoices (id, invoice_number, description, customer_name, customer_email, total_amount) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [id, invoiceNumber, description, customerName || null, customerEmail || null, totalAmount]
    );
    res.status(201).json({ invoice: { ...result.rows[0], paid_amount: "0.00", balance_due: String(totalAmount) } });
  } catch (error) { next(error); }
});

app.get("/api/invoices/:id", requireInternalAccess, async (req, res, next) => {
  try {
    const invoice = await pool.query(`
      SELECT i.id, i.invoice_number, i.description, i.customer_name, i.customer_email,
        i.total_amount, i.currency, i.status, i.created_at, i.due_at,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric(12,2) AS paid_amount,
        GREATEST(i.total_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0), 0)::numeric(12,2) AS balance_due
      FROM invoices i LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.id = $1 GROUP BY i.id
    `, [req.params.id]);
    if (!invoice.rowCount) return res.status(404).json({ error: "Invoice not found." });
    const payments = await pool.query("SELECT id, tx_ref, amount, currency, status, checkout_url, receipt_number, created_at, paid_at FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at DESC", [req.params.id]);
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
