(() => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const $ = (s) => document.querySelector(s);
  let invoice = null;
  let currentReceipt = null;
  const money = (v) => new Intl.NumberFormat("en-MW",{style:"currency",currency:"MWK",maximumFractionDigits:0}).format(Number(v||0));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const setMessage = (text, error=false) => { $("#message").textContent=text; $("#message").className="message"+(error?" error":""); };
  async function load() {
    try {
      const r=await fetch("/api/public/invoices/"+encodeURIComponent(id),{cache:"no-store"});
      const d=await r.json(); if(!r.ok) throw new Error(d.error||"Could not load invoice.");
      invoice=d.invoice;
      document.title=invoice.invoice_number+" — Tambala Pay";
      $("#title").textContent=invoice.invoice_number;
      $("#description").textContent=invoice.description+(invoice.customer_name?" · Billed to "+invoice.customer_name:"");
      $("#total").textContent=money(invoice.total_amount);
      $("#paid").textContent=money(invoice.paid_amount);
      $("#balance").textContent=money(invoice.balance_due);
      $("#amount").max=Number(invoice.balance_due);
      $("#amount").placeholder="Up to "+Number(invoice.balance_due).toLocaleString("en-MW");
      const amounts=[Math.min(1000,Number(invoice.balance_due)),Math.min(5000,Number(invoice.balance_due)),Number(invoice.balance_due)].filter((v,i,a)=>v>0&&a.indexOf(v)===i);
      $("#quickAmounts").innerHTML=amounts.map(v=>'<button type="button" data-amount="'+v+'">'+(v===Number(invoice.balance_due)?"Pay full balance":money(v))+'</button>').join("");
      $("#quickAmounts").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>$("#amount").value=b.dataset.amount));
      $("#payments").innerHTML=(d.payments||[]).length?(d.payments.map(p=>'<div class="payment"><span>'+esc(new Date(p.paid_at||p.created_at).toLocaleDateString())+' · <span class="badge">Verified</span>'+(p.receipt_number?' · '+esc(p.receipt_number):'')+'</span><strong>'+money(p.amount)+'</strong>'+(p.receipt_number?'<button class="smallbtn" type="button" data-view-receipt="'+esc(p.id)+'">View receipt</button>':'')+'</div>').join("")):'<p class="muted">No completed payments yet.</p>';
      const qrResponse = await fetch("/api/public/invoices/"+encodeURIComponent(id)+"/qr",{cache:"no-store"});
      const qrData = await qrResponse.json();
      if(qrResponse.ok && qrData.qr_data_url) { $("#invoiceQr").src=qrData.qr_data_url; $("#downloadInvoiceQr").dataset.qr=qrData.qr_data_url; }
      if(invoice.status==="paid"||invoice.status==="cancelled"||Number(invoice.balance_due)<=0){$("#payForm").classList.add("hidden");setMessage(invoice.status==="paid"?"This invoice has been paid in full.":"This invoice is not currently open for payment.");}
      const p=new URLSearchParams(location.search).get("payment");
      if(p==="checking") setMessage("Returned from checkout. Refreshing the verified payment status…");
      if(p==="success") setMessage("Payment verification completed. Check the updated balance below.");
    } catch(e){$("#title").textContent="Invoice unavailable";setMessage(e.message,true);$("#payForm").classList.add("hidden");}
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

  $("#payForm").addEventListener("submit",async e=>{
    e.preventDefault(); if(!invoice)return;
    const amount=Number($("#amount").value);
    if(!Number.isFinite(amount)||amount<1||amount>Number(invoice.balance_due)){setMessage("Enter an amount between MWK 1 and the remaining balance.",true);return;}
    const b=$("#payButton");b.disabled=true;b.textContent="Preparing secure checkout…";setMessage("");
    try{
      const r=await fetch("/api/public/invoices/"+encodeURIComponent(id)+"/payments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount,email:$("#payerEmail").value.trim()})});
      const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not start payment.");
      if(window.paychanguSdkLoadFailed || typeof window.PaychanguCheckout!=="function") throw new Error("PayChangu popup did not load in this browser. Check your internet connection, then refresh the invoice and try again.");
      if(!d.payment||!d.payment.checkout) throw new Error("Secure checkout could not be prepared. Please try again.");
      window.PaychanguCheckout(d.payment.checkout);
      b.textContent="Checkout opened — complete payment in the popup";
      setMessage("Complete the payment in the PayChangu popup. Your invoice will update after verification.");
      // If the customer closes the popup, allow them to retry without reloading the invoice.
      window.setTimeout(()=>{b.disabled=false;b.textContent="Continue to secure payment →";},15000);
    }catch(err){setMessage(err.message,true);b.disabled=false;b.textContent="Continue to secure payment →";}
  });
  load();
  // Payment providers may redirect before their webhook finishes; refresh the verified state briefly.
  if (new URLSearchParams(location.search).has("payment")) {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      await load();
      if (attempts >= 6) clearInterval(timer);
    }, 4000);
  }
})();