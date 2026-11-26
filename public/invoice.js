(() => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const $ = (s) => document.querySelector(s);
  let invoice = null;
  let currentReceipt = null;
  let selectedPeriod = null;
  let preparedCheckout = null;
  let preparedCheckoutSignature = null;
  let prepareTimer = null;
  let preparing = false;
  let preparingSignature = null;
  const money = (v) => new Intl.NumberFormat("en-MW",{style:"currency",currency:"MWK",maximumFractionDigits:0}).format(Number(v||0));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const setMessage = (text, error=false) => { $("#message").textContent=text; $("#message").className="message"+(error?" error":""); };
  async function verifyReturnedPayment() {
    const params = new URLSearchParams(location.search);
    const txRef = params.get("tx_ref");
    if (!txRef) return null;
    const response = await fetch("/api/public/invoices/" + encodeURIComponent(id) + "/verify-payment", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_ref: txRef }), cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "We could not verify the payment yet.");
    return data.status;
  }
  async function load() {
    try {
      const r=await fetch("/api/public/invoices/"+encodeURIComponent(id),{cache:"no-store"});
      const d=await r.json(); if(!r.ok) throw new Error(d.error||"Could not load invoice.");
      invoice=d.invoice;
      document.title=invoice.invoice_number+" — Tambala Pay";
      $("#title").textContent=invoice.invoice_number;
      $("#description").textContent=invoice.description+(invoice.customer_name?" · Billed to "+invoice.customer_name:"");
      $("#total").textContent=money(invoice.total_amount)+(invoice.recurring_monthly?" / month":"");
      $("#paid").textContent=money(invoice.paid_amount);
      $("#balance").textContent=invoice.recurring_monthly?"Monthly contract":money(invoice.balance_due);
      if (invoice.recurring_monthly) {
        $("#monthlyCalendar").classList.remove("hidden");
        $("#payForm").querySelector(".label").textContent="Payment amount";
        $("#amount").value=Number(invoice.total_amount);
        $("#amount").readOnly=true;
        $("#amount").max=Number(invoice.total_amount);
        $("#amount").min=Number(invoice.total_amount);
        $("#quickAmounts").classList.add("hidden");
        $("#payButton").textContent="Pay Now";
        const periods=d.periods||[];
        $("#monthlyPeriods").innerHTML=periods.map(p=>{
          const disabled=p.status==="paid"||p.status==="pending"||p.status==="upcoming";
          const label=p.status==="paid"?"Paid":p.status==="pending"?"Payment pending":p.status==="upcoming"?"Upcoming":"Select to pay";
          return '<div class="payment"><span><strong>'+esc(p.label)+'</strong><br><span class="muted">'+esc(label)+'</span></span>'+
            (disabled?'<span class="badge">'+esc(label)+'</span>':'<button class="smallbtn" type="button" data-period="'+esc(p.period_key)+'">Pay '+money(invoice.total_amount)+'</button>')+'</div>';
        }).join("")||'<p class="muted">No billing periods are available.</p>';
      } else {
        $("#amount").max=Number(invoice.balance_due);
        $("#amount").placeholder="Up to "+Number(invoice.balance_due).toLocaleString("en-MW");
        const amounts=[Math.min(1000,Number(invoice.balance_due)),Math.min(5000,Number(invoice.balance_due)),Number(invoice.balance_due)].filter((v,i,a)=>v>0&&a.indexOf(v)===i);
        $("#quickAmounts").innerHTML=amounts.map(v=>'<button type="button" data-amount="'+v+'">'+(v===Number(invoice.balance_due)?"Pay full balance":money(v))+'</button>').join("");
        $("#quickAmounts").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{ $("#amount").value=b.dataset.amount; scheduleCheckoutPreparation(); }));
      }
      $("#payments").innerHTML=(d.payments||[]).length?(d.payments.map(p=>'<div class="payment"><span>'+esc(p.period_key||new Date(p.paid_at||p.created_at).toLocaleDateString())+' · <span class="badge">Verified</span>'+(p.receipt_number?' · '+esc(p.receipt_number):'')+'</span><strong>'+money(p.amount)+'</strong>'+(p.receipt_number?'<button class="smallbtn" type="button" data-view-receipt="'+esc(p.id)+'">View receipt</button>':'')+'</div>').join("")):'<p class="muted">No completed payments yet.</p>';
      const qrResponse = await fetch("/api/public/invoices/"+encodeURIComponent(id)+"/qr",{cache:"no-store"});
      const qrData = await qrResponse.json();
      if(qrResponse.ok && qrData.qr_data_url) { $("#invoiceQr").src=qrData.qr_data_url; $("#downloadInvoiceQr").dataset.qr=qrData.qr_data_url; }
      if(invoice.status==="cancelled"||(!invoice.recurring_monthly&&(invoice.status==="paid"||Number(invoice.balance_due)<=0))){$("#payForm").classList.add("hidden");setMessage(invoice.status==="paid"?"This invoice has been paid in full.":"This invoice is not currently open for payment.");}
      const p=new URLSearchParams(location.search).get("payment");
      if(p==="checking") setMessage("Checking payment status…");
      if(p==="success") setMessage("Payment verified.");
      scheduleCheckoutPreparation();
    } catch(e){$("#title").textContent="Invoice unavailable";setMessage(e.message,true);$("#payForm").classList.add("hidden");}
  }
  function checkoutDetails() {
    if (!invoice) return null;
    const amount = Number($("#amount").value);
    const email = $("#payerEmail").value.trim();
    if (invoice.recurring_monthly && !selectedPeriod) return null;
    if (!Number.isFinite(amount) || amount < 1 || (!invoice.recurring_monthly && amount > Number(invoice.balance_due))) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { amount, email, signature: JSON.stringify({amount,email:email.toLowerCase(),period:invoice.recurring_monthly?selectedPeriod:null}) };
  }
  async function prepareCheckout() {
    const details=checkoutDetails();
    if (!details) return;
    const {amount,email,signature}=details;
    if (preparedCheckout && preparedCheckoutSignature===signature) return;
    if (preparing) return;
    preparing=true;
    preparingSignature=signature;
    const button=$("#payButton");
    button.disabled=true;
    button.textContent="Preparing payment…";
    try {
      if (window.paychanguSdkLoadFailed || typeof window.PaychanguCheckout!=="function") throw new Error("PayChangu checkout could not load. Check your connection and refresh.");
      const paymentUrl=invoice.recurring_monthly
        ? "/api/public/invoices/"+encodeURIComponent(id)+"/periods/"+encodeURIComponent(selectedPeriod)+"/payments"
        : "/api/public/invoices/"+encodeURIComponent(id)+"/payments";
      const response=await fetch(paymentUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount,email})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"Could not prepare payment.");
      if(!data.payment||!data.payment.checkout||!data.payment.checkout.public_key) throw new Error("Secure checkout could not be prepared.");
      const latest=checkoutDetails();
      if(!latest||latest.signature!==signature) return;
      preparedCheckout=data.payment.checkout;
      preparedCheckoutSignature=signature;
      button.disabled=false;
      button.textContent="Pay Now";
      setMessage("Your payment is ready. Tap Pay Now to open secure checkout.");
    } catch(error) {
      preparedCheckout=null; preparedCheckoutSignature=null;
      button.disabled=false;
      button.textContent="Pay Now";
      setMessage(error.message,true);
    } finally {
      preparing=false;
      preparingSignature=null;
      const latest=checkoutDetails();
      if(latest && latest.signature!==signature) scheduleCheckoutPreparation();
    }
  }
  function scheduleCheckoutPreparation() {
    preparedCheckout=null;
    preparedCheckoutSignature=null;
    if(prepareTimer) clearTimeout(prepareTimer);
    const button=$("#payButton");
    if(button){button.disabled=true;button.textContent="Preparing payment…";}
    if(!checkoutDetails()) {
      if(button){button.disabled=false;button.textContent="Pay Now";}
      return;
    }
    prepareTimer=setTimeout(()=>prepareCheckout(),350);
  }
  function receiptMarkup(r) {
    const rows = [
      ["Receipt number",r.receipt_number],["Invoice",r.invoice_number],["Description",r.description],
      ["Customer",r.customer_name||"Customer"],["Amount paid",money(r.amount)],
      ["Payment reference",r.tx_ref],["Provider reference",r.provider_reference||"Not supplied"],
      ["Payment date",r.paid_at?new Date(r.paid_at).toLocaleString():"Verified payment"]
    ];
    return rows.map(([k,v])=>'<span>'+esc(k)+'</span><strong>'+esc(v)+'</strong>').join("");
  }
  function receiptDocument(r) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+esc(r.receipt_number)+' — Tambala Pay receipt</title><style>body{font:15px/1.5 Arial,sans-serif;color:#182437;max-width:700px;margin:32px auto;padding:24px}.brand{color:#176d55;font-weight:800;letter-spacing:.1em}.tag{color:#176d55;font-weight:700;margin-top:28px}h1{margin:6px 0 22px}table{width:100%;border-collapse:collapse}td{padding:13px 8px;border-bottom:1px solid #e2e8ed}td:first-child{color:#68778a;width:38%}.foot{margin-top:34px;color:#68778a;font-size:12px;border-top:1px solid #e2e8ed;padding-top:14px}.actions{margin-top:22px}@media print{.actions{display:none}body{margin:0}}</style></head><body><div class="brand">TAMBALA PAY</div><div class="tag">PAYMENT CONFIRMED</div><h1>Payment receipt</h1><table>'+[
      ["Receipt number",r.receipt_number],["Invoice",r.invoice_number],["Description",r.description],
      ["Customer",r.customer_name||"Customer"],["Amount paid",money(r.amount)],
      ["Payment reference",r.tx_ref],["Provider reference",r.provider_reference||"Not supplied"],
      ["Payment date",r.paid_at?new Date(r.paid_at).toLocaleString():"Verified payment"]
    ].map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+esc(v)+'</td></tr>').join("")+'</table><div class="foot">This receipt represents a payment verified by Tambala Pay. Keep it for your records.</div><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div></body></html>';
  }
  async function viewReceipt(paymentId) {
    setMessage("Loading verified receipt…");
    try {
      const response=await fetch("/api/public/payments/"+encodeURIComponent(paymentId)+"/receipt",{cache:"no-store"});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"Receipt is not available yet.");
      currentReceipt=data.receipt;
      $("#receiptDetails").innerHTML=receiptMarkup(currentReceipt);
      $("#receiptView").classList.remove("hidden");
      setMessage("Verified receipt opened below. You can download it or save it as PDF.");
      $("#receiptView").scrollIntoView({behavior:"smooth",block:"center"});
    } catch(e) { setMessage(e.message,true); }
  }
  $("#payments").addEventListener("click",e=>{
    const button=e.target.closest("[data-view-receipt]");
    if(button) viewReceipt(button.dataset.viewReceipt);
  });
  $("#downloadInvoiceQr").addEventListener("click",()=>{
    const src=$("#downloadInvoiceQr").dataset.qr;
    if(!src) return;
    const a=document.createElement("a");a.href=src;a.download="tambala-pay-invoice-qr.png";document.body.appendChild(a);a.click();a.remove();
  });
  $("#downloadReceipt").addEventListener("click",()=>{
    if(!currentReceipt) return;
    const blob=new Blob([receiptDocument(currentReceipt)],{type:"text/html;charset=utf-8"});
    const url=URL.createObjectURL(blob);const a=document.createElement("a");
    a.href=url;a.download=(currentReceipt.receipt_number||"tambala-pay-receipt")+".html";
    document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  });
  $("#printReceipt").addEventListener("click",()=>{
    if(!currentReceipt)return;
    const win=window.open("","_blank","width=720,height=820");
    if(!win){setMessage("Allow pop-ups to print or save the receipt as PDF.",true);return;}
    win.document.open();win.document.write(receiptDocument(currentReceipt));win.document.close();
    win.onload=()=>win.print();
  });
  $("#closeReceipt").addEventListener("click",()=>$("#receiptView").classList.add("hidden"));

  $("#monthlyPeriods").addEventListener("click",e=>{
    const button=e.target.closest("[data-period]");
    if(!button)return;
    selectedPeriod=button.dataset.period;
    $("#monthlyPeriods").querySelectorAll("[data-period]").forEach(x=>x.classList.toggle("selected",x===button));
    setMessage("Selected "+button.closest(".payment").querySelector("strong").textContent+". Enter your email to prepare payment.");
    $("#payerEmail").focus();
    scheduleCheckoutPreparation();
  });
  $("#payerEmail").addEventListener("input",scheduleCheckoutPreparation);
  $("#amount").addEventListener("input",scheduleCheckoutPreparation);
  $("#payButton").addEventListener("click",()=>{
    const details=checkoutDetails();
    if(!details){setMessage(invoice&&invoice.recurring_monthly&&!selectedPeriod?"Select the month you are paying for first.":"Enter a valid amount and email address.",true);return;}
    if(!preparedCheckout||preparedCheckoutSignature!==details.signature){
      setMessage("Your payment is still being prepared. The Pay Now button will be ready in a moment.");
      scheduleCheckoutPreparation();
      return;
    }
    if(window.paychanguSdkLoadFailed||typeof window.PaychanguCheckout!=="function"){
      setMessage("PayChangu checkout did not load. Refresh the invoice and try again.",true);return;
    }
    try {
      window.PaychanguCheckout(preparedCheckout);
      setMessage("Complete your payment in the PayChangu popup.");
    } catch(error) { setMessage("PayChangu could not open checkout: "+(error.message||"Please try again."),true); }
  });
  const returnParams = new URLSearchParams(location.search);
  if (returnParams.has("payment") || returnParams.has("tx_ref")) {
    (async () => {
      try {
        const status = await verifyReturnedPayment();
        if (status === "success") setMessage("Payment verified. Refreshing your invoice balance…");
        else if (status && ["failed", "cancelled", "canceled"].includes(status)) setMessage("This payment was not completed. You can try again.");
        else setMessage("Checking payment status with PayChangu…");
      } catch (error) {
        setMessage("Payment status is still pending.", false);
      }
      await load();
    })();
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      try { await verifyReturnedPayment(); } catch (_) {}
      await load();
      if (attempts >= 6) clearInterval(timer);
    }, 4000);
  } else {
    load();
  }
})();