(() => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const $ = (s) => document.querySelector(s);
  let invoice = null;
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
      $("#payments").innerHTML=(d.payments||[]).length?(d.payments.map(p=>'<div class="payment"><span>'+esc(new Date(p.paid_at||p.created_at).toLocaleDateString())+' · <span class="badge">Verified</span>'+(p.receipt_number?' · Receipt '+esc(p.receipt_number):'')+'</span><strong>'+money(p.amount)+'</strong></div>').join("")):'<p class="muted">No completed payments yet.</p>';
      if(invoice.status==="paid"||invoice.status==="cancelled"||Number(invoice.balance_due)<=0){$("#payForm").classList.add("hidden");setMessage(invoice.status==="paid"?"This invoice has been paid in full.":"This invoice is not currently open for payment.");}
      const p=new URLSearchParams(location.search).get("payment");
      if(p==="checking") setMessage("Returned from checkout. Refreshing the verified payment status…");
      if(p==="success") setMessage("Payment verification completed. Check the updated balance below.");
    } catch(e){$("#title").textContent="Invoice unavailable";setMessage(e.message,true);$("#payForm").classList.add("hidden");}
  }
  $("#payForm").addEventListener("submit",async e=>{
    e.preventDefault(); if(!invoice)return;
    const amount=Number($("#amount").value);
    if(!Number.isFinite(amount)||amount<1||amount>Number(invoice.balance_due)){setMessage("Enter an amount between MWK 1 and the remaining balance.",true);return;}
    const b=$("#payButton");b.disabled=true;b.textContent="Preparing secure checkout…";setMessage("");
    try{
      const r=await fetch("/api/public/invoices/"+encodeURIComponent(id)+"/payments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount})});
      const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not start payment.");
      location.href=d.payment.checkout_url;
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