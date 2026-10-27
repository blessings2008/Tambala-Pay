(() => {
  const TOKEN_KEY = "tambalaPayInternalToken";
  const $ = (selector) => document.querySelector(selector);
  const state = { token: localStorage.getItem(TOKEN_KEY) || "", requests: [] };

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
      const [summary, list] = await Promise.all([api("/api/summary"), api("/api/requests")]);
      $("#collected").textContent = money(summary.collected_mwk);
      $("#pendingAmount").textContent = money(summary.pending_mwk);
      $("#successfulCount").textContent = summary.successful_payments || 0;
      $("#totalCount").textContent = summary.total_requests || 0;
      state.requests = list.requests || [];
      renderRequests();
    } catch (error) {
      showToast(error.message);
      if (error.message.includes("Internal access")) lockWorkspace();
    }
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

  $("#signOut").addEventListener("click", lockWorkspace);
  $("#refreshButton").addEventListener("click", loadWorkspace);
  $("#requestsBody").addEventListener("click", handleTableAction);

  $("#requestForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#createButton");
    button.disabled = true;
    button.textContent = "Creating secure checkout…";
    message($("#requestMessage"), "Creating the request with PayChangu…");
    const payload = {
      description: $("#description").value.trim(),
      amount: Number($("#amount").value),
      customerName: $("#customerName").value.trim(),
      customerEmail: $("#customerEmail").value.trim()
    };
    try {
      const result = await api("/api/requests", { method: "POST", body: JSON.stringify(payload) });
      $("#requestForm").reset();
      message($("#requestMessage"), "Payment request created. Share the checkout link with your customer.", "success");
      showToast("Payment request created.");
      await loadWorkspace();
      const checkout = result.request.checkout_url;
      if (checkout) {
        const shouldOpen = window.confirm("Payment request created. Open the PayChangu checkout now? Choose Cancel to copy the link from the requests table.");
        if (shouldOpen) window.open(checkout, "_blank", "noopener,noreferrer");
        else {
          try { await navigator.clipboard.writeText(checkout); showToast("Checkout link copied."); }
          catch { window.prompt("Copy this checkout link:", checkout); }
        }
      }
    } catch (error) {
      message($("#requestMessage"), error.message, "error");
    } finally {
      button.disabled = false;
      button.innerHTML = 'Create payment link <span>→</span>';
    }
  });

  const paymentState = new URLSearchParams(window.location.search).get("payment");
  if (paymentState === "success") showToast("Payment verification completed. Refreshing transaction status.");
  else if (paymentState === "failed" || paymentState === "cancelled") showToast("Payment was not completed. The request remains in your history.");
  else if (paymentState === "checking") showToast("Payment is being checked. Refresh the workspace shortly.");

  if (state.token) unlock(state.token);
})();
