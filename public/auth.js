(() => {
  const TOKEN_KEY = "tambalaPayInternalToken";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll"];
  let supabaseClient = null;
  let inactivityTimer = null;
  let lastActivity = Date.now();
  const $ = (selector) => document.querySelector(selector);

  function injectAuthStyles() {
    if (document.getElementById("tambalaAuthStyles")) return;
    const style = document.createElement("style");
    style.id = "tambalaAuthStyles";
    style.textContent = `
      .auth-login{max-width:430px;display:grid;gap:12px}.auth-login label{margin-top:2px}.auth-login input{width:100%;box-sizing:border-box}.button-google{width:100%;justify-content:center;background:#fff;border:1px solid #d8dee8;color:#182437}.button-google:hover{background:#f7f9fb}.google-g{font-weight:800;font-size:17px}.auth-divider{display:flex;align-items:center;gap:12px;color:#7a8494;font-size:12px;margin:4px 0}.auth-divider:before,.auth-divider:after{content:"";height:1px;background:#e2e7ed;flex:1}.auth-link{border:0;background:none;color:#176d55;font-weight:700;cursor:pointer;padding:4px}.auth-link:hover{text-decoration:underline}.auth-message{margin:2px 0 0}.auth-message.success{color:#176d55}.access-copy p{margin:6px 0 0;color:#687487}
    `;
    document.head.appendChild(style);
  }

  function showAuthMessage(text, kind = "") {
    const node = $("#accessMessage");
    if (!node) return;
    node.textContent = text || "";
    node.className = "form-message auth-message" + (kind ? " " + kind : "");
  }

  function setLoginBusy(busy) {
    ["#googleSignIn", "#emailSignIn"].forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = busy;
    });
  }

  function renderLogin() {
    const form = $("#accessForm");
    if (!form) return;
    form.innerHTML = `
      <div class="auth-login">
        <button id="googleSignIn" class="button button-google" type="button"><span class="google-g">G</span> Continue with Google</button>
        <div class="auth-divider"><span>or</span></div>
        <label for="loginEmail">Email</label>
        <input id="loginEmail" type="email" autocomplete="email" placeholder="you@example.com">
        <label for="loginPassword">Password</label>
        <input id="loginPassword" type="password" autocomplete="current-password" placeholder="Your password">
        <button id="emailSignIn" class="button button-primary button-wide" type="button">Sign in</button>
        <button id="forgotPassword" class="auth-link" type="button">Forgot password?</button>
        <p id="accessMessage" class="form-message auth-message" role="status"></p>
      </div>
      <input id="accessToken" type="hidden" value="">
    `;
    $("#googleSignIn").addEventListener("click", signInWithGoogle);
    $("#emailSignIn").addEventListener("click", signInWithEmail);
    $("#forgotPassword").addEventListener("click", sendPasswordReset);
  }

  async function loadConfig() {
    const response = await fetch("/api/auth/config", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.supabaseUrl || !data.publishableKey) {
      throw new Error(data.error || "Supabase authentication is not configured on the server. Add the Supabase Auth variables in Render.");
    }
    supabaseClient = window.supabase.createClient(data.supabaseUrl, data.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  function resetInactivityTimer() {
    lastActivity = Date.now();
    if (!supabaseClient) return;
    window.clearTimeout(inactivityTimer);
    inactivityTimer = window.setTimeout(expireInactiveSession, SESSION_TIMEOUT_MS);
  }

  async function expireInactiveSession() {
    if (!supabaseClient) return;
    if (Date.now() - lastActivity < SESSION_TIMEOUT_MS) {
      resetInactivityTimer();
      return;
    }
    await supabaseClient.auth.signOut();
    localStorage.removeItem(TOKEN_KEY);
    showAuthMessage("Your session expired after 30 minutes of inactivity. Sign in again.", "error");
    const workspace = $("#workspace");
    const accessPanel = $("#accessPanel");
    if (workspace) workspace.classList.add("hidden");
    if (accessPanel) accessPanel.classList.remove("hidden");
    const signOut = $("#signOut");
    if (signOut) signOut.classList.add("hidden");
  }

  function startActivityTracking() {
    ACTIVITY_EVENTS.forEach((eventName) => {
      window.addEventListener(eventName, resetInactivityTimer, { passive: true });
    });
    resetInactivityTimer();
  }

  async function handSessionToDashboard(session) {
    if (!session || !session.access_token) return false;
    localStorage.setItem(TOKEN_KEY, session.access_token);
    const tokenInput = $("#accessToken");
    if (tokenInput) tokenInput.value = session.access_token;
    resetInactivityTimer();
    const form = $("#accessForm");
    if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  }

  async function signInWithGoogle() {
    if (!supabaseClient) return;
    setLoginBusy(true);
    showAuthMessage("");
    const { error } = await supabaseClient.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin + "/" } });
    if (error) { setLoginBusy(false); showAuthMessage(error.message, "error"); }
  }

  async function signInWithEmail() {
    if (!supabaseClient) return;
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    if (!email || !password) { showAuthMessage("Enter your email and password.", "error"); return; }
    setLoginBusy(true);
    showAuthMessage("");
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) { setLoginBusy(false); showAuthMessage(error.message, "error"); return; }
    await handSessionToDashboard(data.session);
  }

  async function sendPasswordReset() {
    if (!supabaseClient) return;
    const email = $("#loginEmail").value.trim();
    if (!email) { showAuthMessage("Enter your email first.", "error"); return; }
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/" });
    if (error) showAuthMessage(error.message, "error");
    else showAuthMessage("Password reset email sent.", "success");
  }

  async function boot() {
    injectAuthStyles();
    renderLogin();
    try {
      await loadConfig();
      startActivityTracking();
      const { data } = await supabaseClient.auth.getSession();
      if (data.session) await handSessionToDashboard(data.session);

      supabaseClient.auth.onAuthStateChange((_event, session) => {
        if (session) handSessionToDashboard(session);
        else {
          localStorage.removeItem(TOKEN_KEY);
          window.clearTimeout(inactivityTimer);
        }
      });

      const signOut = $("#signOut");
      if (signOut) signOut.addEventListener("click", async () => {
        await supabaseClient.auth.signOut();
        localStorage.removeItem(TOKEN_KEY);
        window.clearTimeout(inactivityTimer);
      }, { capture: true });
    } catch (error) {
      showAuthMessage(error.message, "error");
      [$("#googleSignIn"), $("#emailSignIn")].forEach((button) => { if (button) button.disabled = true; });
    }
  }

  boot();
})();
