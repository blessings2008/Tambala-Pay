(() => {
  const TOKEN_KEY = "tambalaPayInternalToken";
  const $ = (selector) => document.querySelector(selector);
  const state = { token: localStorage.getItem(TOKEN_KEY) || "", requests: [], invoices: [], qrPayment: null };

  const money = (value) => new Intl.NumberFormat("en-MW", {
    style: "currency", currency: "MWK", maximumFractionDigits: 0
  }).format(Number(value || 0)).replace("MWK", "MWK");
  const date = (value) => value ? new Date(value).toLocaleString("en-MW", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  }) : "—";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));

  async function api(url, options = {}) {
    const headers = { Authorization: "Bearer " + state.token, ...(options.headers || {}) };
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ").");
    return data;
  }

  function message(element, text, kind = "") {
    element.textContent = text;
    element.className = "form-message" + (kind ? " " + kind : "");
  }

  function showToast(text) {
    const toast = $("#toast");
    toast.textContent = text;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function showPaymentQr(payment, invoiceId) {
    state.qrPayment = payment;
    const invoice = state.invoices.find((item) => item.id === invoiceId);
    $("#qrTitle").textContent = invoice ? "Payment for " + invoice.invoice_number : "Scan to pay";
    $("#qrDescription").textContent = "Let the customer scan this code with another phone to open the secure PayChangu checkout.";
    $("#qrImage").src = payment.qr_data_url;
    $("#qrAmount").textContent = money(payment.amount) + (invoice ? " · " + invoice.invoice_number : "");
    $("#qrOpenLink").href = payment.checkout_url;
    $("#qrDialog").classList.remove("hidden");
    $("#closeQr").focus();
  }

  async function showInvoiceLinkPreview(invoice) {
    try {
      const url = window.location.origin + "/invoice/" + encodeURIComponent(invoice.id);
      const response = await fetch("/api/public/invoices/" + encodeURIComponent(invoice.id) + "/qr", {
        headers: { Authorization: "Bearer " + state.token }, cache: "no-store"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not prepare invoice QR code.");
      state.qrPayment = {
        qr_data_url: data.qr_data_url, checkout_url: url,
        tx_ref: "invoice-" + invoice.invoice_number, amount: invoice.total_amount
      };
      $("#qrTitle").textContent = "Share " + invoice.invoice_number;
      $("#qrDescription").textContent = "This QR code opens the customer's invoice page, where they can see the balance, view receipts and pay in parts.";
      $("#qrImage").src = data.qr_data_url;
      $("#qrImage").alt = "QR code linking to invoice " + invoice.invoice_number;
      $("#qrAmount").textContent = money(invoice.total_amount) + " · " + invoice.invoice_number;
      $("#qrOpenLink").href = url;
      $("#qrDialog").classList.remove("hidden");
      $("#closeQr").focus();
    } catch (error) { showToast(error.message); }
  }

  function setUnlocked(unlocked) {
    $("#accessPanel").classList.toggle("hidden", unlocked);
    $("#workspace").classList.toggle("hidden", !unlocked);
    $("#signOut").classList.toggle("hidden", !unlocked);
    if (unlocked) loadWorkspace();
  }

  async function unlock(token) {
    state.token = token;
    try {
      await api("/api/summary");
      localStorage.setItem(TOKEN_KEY, token);
      message($("#accessMessage"), "");
      setUnlocked(true);
    } catch (error) {
      state.token = "";
      localStorage.removeItem(TOKEN_KEY);
      message($("#accessMessage"), error.message, "error");
    }
  }

  async function loadWorkspace() {
    try {
      const [summary, list, invoiceList] = await Promise.all([api("/api/summary"), api("/api/requests"), api("/api/invoices")]);
      $("#collected").textContent = money(summary.collected_mwk);
      $("#pendingAmount").textContent = money(summary.pending_mwk);
      $("#successfulCount").textContent = summary.successful_payments || 0;
      $("#totalCount").textContent = summary.total_requests || 0;
      state.requests = list.requests || [];
      state.invoices = invoiceList.invoices || [];
      renderRequests();
      renderInvoices();
    } catch (error) {
      showToast(error.message);
      if (error.message.includes("Internal access")) lockWorkspace();
    }
  }

  function renderInvoices() {
    const body = $("#invoicesBody");
    if (!state.invoices.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty-cell">No invoices yet. Create one above.</td></tr>';
      $("#invoicesFoot").textContent = "Create each invoice once, then record one or more partial payments against it.";
      return;
    }
    body.innerHTML = state.invoices.map((item) => {
      const shareUrl = window.location.origin + "/invoice/" + encodeURIComponent(item.id);
      const actions = (item.status !== "paid" && item.status !== "cancelled"
        ? '<button class="table-action" data-pay-invoice="' + escapeHtml(item.id) + '" data-balance="' + escapeHtml(item.balance_due) + '">Collect payment</button> '
        : '') + '<button class="table-action" data-copy-invoice="' + escapeHtml(item.id) + '">Copy invoice link</button> <button class="table-action" data-share-invoice="' + escapeHtml(item.id) + '">Link preview &amp; QR</button> <button class="table-action" data-invoice-details="' + escapeHtml(item.id) + '">Details</button>';
      return '<tr><td><div class="reference">' + escapeHtml(item.invoice_number) + '</div><div class="subline">' + escapeHtml(item.description) + '</div></td>' +
        '<td>' + escapeHtml(item.customer_name || "Not specified") + '<div class="subline">' + escapeHtml(item.customer_email || "") + '</div></td>' +
        '<td class="amount-cell">' + money(item.total_amount) + '</td><td>' + money(item.paid_amount) + '</td>' +
        '<td class="amount-cell">' + money(item.balance_due) + '</td><td>' + statusPill(item.status === "open" ? "pending" : item.status === "partially_paid" ? "pending" : item.status) + '</td>' +
        '<td class="date-cell">' + escapeHtml(date(item.created_at)) + '</td><td class="actions-cell">' + actions + '</td></tr>';
    }).join("");
    $("#invoicesFoot").textContent = state.invoices.length + " invoices · Collect any amount up to the outstanding balance. Each successful payment gets its own receipt.";
  }

  function statusPill(status) {
    const labels = { paid: "Paid", pending: "Pending", failed: "Failed", cancelled: "Cancelled" };
    return '<span class="status-pill status-' + escapeHtml(status) + '"><span></span>' + (labels[status] || escapeHtml(status)) + "</span>";
  }

  function renderRequests() {
    const body = $("#requestsBody");
    if (!state.requests.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-cell">No payment requests yet. Create your first request above.</td></tr>';
      $("#tableFoot").textContent = "Your internal payment history will appear here.";
      return;
    }
    body.innerHTML = state.requests.map((item) => {
      const customer = item.customer_name || "Not specified";
      const action = item.status === "paid" && item.receipt_number
        ? '<button class="table-action" data-receipt="' + escapeHtml(item.id) + '">Receipt ↗</button>'
        : item.checkout_url && item.status === "pending"
          ? '<button class="table-action" data-copy="' + escapeHtml(item.checkout_url) + '">Copy link ↗</button>'
          : '<span class="muted">—</span>';
      return '<tr>' +
        '<td><div class="reference">' + escapeHtml(item.tx_ref) + '</div><div class="subline">' + escapeHtml(item.description) + '</div></td>' +
        '<td><span class="payment-title">' + escapeHtml(item.description) + '</span></td>' +
        '<td><span>' + escapeHtml(customer) + '</span><div class="subline">' + escapeHtml(item.customer_email || "") + '</div></td>' +
        '<td class="amount-cell">' + money(item.amount) + '</td>' +
        '<td>' + statusPill(item.status) + '</td>' +
        '<td class="date-cell">' + escapeHtml(date(item.created_at)) + '</td>' +
        '<td class="actions-cell">' + action + '</td></tr>';
    }).join("");
    $("#tableFoot").textContent = state.requests.length + " recent requests · A receipt is available only after server-side payment verification.";
  }

  function printReceipt(receipt) {
    const win = window.open("", "_blank", "width=720,height=820");
    if (win) win.opener = null;
    if (!win) {
      showToast("Allow pop-ups to print the receipt.");
      return;
    }
    const rows = [
      ["Receipt number", receipt.receipt_number],
      ["Payment reference", receipt.tx_ref],
      ["Description", receipt.description],
      ["Customer", receipt.customer_name || "Not specified"],
      ["Customer email", receipt.customer_email || "Not provided"],
      ["Amount paid", money(receipt.amount)],
      ["Payment method reference", receipt.provider_reference || "Not supplied"],
      ["Paid at", date(receipt.paid_at)]
    ];
    win.document.write('<!doctype html><html><head><title>Tambala Pay Receipt</title><meta charset="utf-8"><style>body{font:15px Arial,sans-serif;color:#182437;max-width:680px;margin:40px auto;padding:24px}.brand{font-weight:800;letter-spacing:.08em;color:#176d55}.tag{color:#16845f;font-weight:700;margin-top:28px}h1{font-size:28px;margin:8px 0}p{color:#657186}table{width:100%;border-collapse:collapse;margin-top:30px}td{padding:14px 8px;border-bottom:1px solid #e3e8ee}td:first-child{color:#657186;width:40%}.amount{font-size:23px;font-weight:800}.foot{margin-top:40px;border-top:1px solid #e3e8ee;padding-top:16px;color:#657186;font-size:12px}@media print{button{display:none}body{margin:0}}</style></head><body>');
    win.document.write('<div class="brand">TAMBALA PAY</div><div class="tag">PAYMENT CONFIRMED</div><h1>Payment receipt</h1><p>Issued by Tambala Technologies</p><table>');
    rows.forEach(([label, value]) => win.document.write("<tr><td>" + escapeHtml(label) + "</td><td>" + escapeHtml(value) + "</td></tr>"));
    win.document.write('</table><div class="foot">This receipt was generated from a payment verified by the server. Keep it for your records.</div><p><button onclick="window.print()">Print / Save as PDF</button></p></body></html>');
    win.document.close();
  }

  async function handleTableAction(event) {
    const receiptButton = event.target.closest("[data-receipt]");
    const copyButton = event.target.closest("[data-copy]");
    if (receiptButton) {
      try {
        const data = await api("/api/requests/" + encodeURIComponent(receiptButton.dataset.receipt) + "/receipt");
        printReceipt(data.receipt);
      } catch (error) { showToast(error.message); }
    }
    if (copyButton) {
      try {
        await navigator.clipboard.writeText(copyButton.dataset.copy);
        showToast("Checkout link copied.");
      } catch {
        window.prompt("Copy this checkout link:", copyButton.dataset.copy);
      }
    }
  }

  function lockWorkspace() {
    state.token = "";
    localStorage.removeItem(TOKEN_KEY);
    state.requests = [];
    setUnlocked(false);
    $("#accessToken").value = "";
    message($("#accessMessage"), "Workspace locked.");
  }

  $("#accessForm").addEventListener("submit", (event) => {
    event.preventDefault();
    unlock($("#accessToken").value.trim());
  });

  $("#closeQr").addEventListener("click", () => $("#qrDialog").classList.add("hidden"));
  $("#qrDialog").addEventListener("click", (event) => {
    if (event.target === $("#qrDialog")) $("#qrDialog").classList.add("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("#qrDialog").classList.add("hidden");
  });
  $("#downloadQr").addEventListener("click", () => {
    if (!state.qrPayment || !state.qrPayment.qr_data_url) return;
    const anchor = document.createElement("a");
    anchor.href = state.qrPayment.qr_data_url;
    anchor.download = "tambala-pay-" + state.qrPayment.tx_ref + ".png";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
  $("#copyQrLink").addEventListener("click", async () => {
    if (!state.qrPayment) return;
    try {
      await navigator.clipboard.writeText(state.qrPayment.checkout_url);
      showToast("Secure payment link copied.");
    } catch {
      window.prompt("Copy this secure payment link:", state.qrPayment.checkout_url);
    }
  });

  $("#signOut").addEventListener("click", lockWorkspace);
  $("#refreshButton").addEventListener("click", loadWorkspace);
  $("#requestsBody").addEventListener("click", handleTableAction);
  $("#refreshInvoices").addEventListener("click", loadWorkspace);
  $("#invoicesBody").addEventListener("click", async (event) => {
    const payButton = event.target.closest("[data-pay-invoice]");
    const detailsButton = event.target.closest("[data-invoice-details]");
    const copyInvoiceButton = event.target.closest("[data-copy-invoice]");
    const shareInvoiceButton = event.target.closest("[data-share-invoice]");
    const invoiceUrl = (id) => window.location.origin + "/invoice/" + encodeURIComponent(id);
    if (copyInvoiceButton) {
      const url = invoiceUrl(copyInvoiceButton.dataset.copyInvoice);
      try { await navigator.clipboard.writeText(url); showToast("Invoice link copied. Send it to your customer."); }
      catch { window.prompt("Copy this invoice link and send it to your customer:", url); }
    }
    if (shareInvoiceButton) {
      const item = state.invoices.find((row) => row.id === shareInvoiceButton.dataset.shareInvoice);
      if (item) await showInvoiceLinkPreview(item);
    }
    if (payButton) {
      const balance = Number(payButton.dataset.balance);
      const raw = window.prompt("Enter the amount to collect now (MWK). Outstanding balance: " + money(balance), String(balance));
      if (raw === null) return;
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 1 || amount > balance) {
        showToast("Enter an amount from MWK 1 up to the outstanding balance.");
        return;
      }
      try {
        const result = await api("/api/invoices/" + encodeURIComponent(payButton.dataset.payInvoice) + "/payments", {
          method: "POST", body: JSON.stringify({ amount })
        });
        await loadWorkspace();
        showPaymentQr(result.payment, payButton.dataset.payInvoice);
      } catch (error) { showToast(error.message); }
    }
    if (detailsButton) {
      try {
        const data = await api("/api/invoices/" + encodeURIComponent(detailsButton.dataset.invoiceDetails));
        const invoice = data.invoice;
        const paymentLines = (data.payments || []).map(p => p.tx_ref + " — " + money(p.amount) + " — " + p.status + (p.receipt_number ? " — receipt " + p.receipt_number : "")).join("\\n");
        window.alert(invoice.invoice_number + "\\n" + invoice.description + "\\nTotal: " + money(invoice.total_amount) + "\\nPaid: " + money(invoice.paid_amount) + "\\nBalance: " + money(invoice.balance_due) + "\\n\\nPayments:\\n" + (paymentLines || "No payments yet."));
      } catch (error) { showToast(error.message); }
    }
  });

  $("#requestForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#createButton");
    button.disabled = true;
    button.textContent = "Creating secure checkout…";
    message($("#requestMessage"), "Creating invoice…");
    const payload = {
      description: $("#description").value.trim(),
      totalAmount: Number($("#amount").value),
      customerName: $("#customerName").value.trim(),
      customerEmail: $("#customerEmail").value.trim()
    };
    try {
      const result = await api("/api/invoices", { method: "POST", body: JSON.stringify(payload) });
      $("#requestForm").reset();
      const shareUrl = window.location.origin + "/invoice/" + encodeURIComponent(result.invoice.id);
      message($("#requestMessage"), "Invoice " + result.invoice.invoice_number + " created. Share this customer link: " + shareUrl, "success");
      try { await navigator.clipboard.writeText(shareUrl); showToast("Invoice created — customer link copied."); }
      catch { window.prompt("Invoice created. Copy and send this link to your customer:", shareUrl); }
      await loadWorkspace();
    } catch (error) {
      message($("#requestMessage"), error.message, "error");
    } finally {
      button.disabled = false;
      button.innerHTML = 'Create invoice <span>→</span>';
    }
  });

  const paymentState = new URLSearchParams(window.location.search).get("payment");
  if (paymentState === "success") showToast("Payment verification completed. Refreshing transaction status.");
  else if (paymentState === "failed" || paymentState === "cancelled") showToast("Payment was not completed. The request remains in your history.");
  else if (paymentState === "checking") showToast("Payment is being checked. Refresh the workspace shortly.");

  if (state.token) unlock(state.token);
})();
