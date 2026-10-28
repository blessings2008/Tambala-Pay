// Authentication bridge for the single-owner Tambala Pay dashboard.
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const SUPABASE_ALLOWED_EMAIL = String(process.env.SUPABASE_ALLOWED_EMAIL || "").trim().toLowerCase();
const AUTH_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_PUBLISHABLE_KEY && SUPABASE_ALLOWED_EMAIL);

if (!AUTH_CONFIGURED) {
  console.warn("Supabase dashboard authentication is not configured. Existing internal-token access remains available until the Supabase Auth variables are added.");
}

const authAdmin = AUTH_CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
}) : null;

function tokenFromRequest(req) {
  const header = req.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function authorizeSupabaseRequest(req) {
  if (!AUTH_CONFIGURED || !authAdmin) return false;
  const token = tokenFromRequest(req);
  if (!token) return false;
  try {
    const { data, error } = await authAdmin.auth.getUser(token);
    if (error || !data.user || !data.user.email) return false;
    return String(data.user.email).trim().toLowerCase() === SUPABASE_ALLOWED_EMAIL;
  } catch {
    return false;
  }
}

if (AUTH_CONFIGURED) {
  const originalRouteMethods = {};
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    originalRouteMethods[method] = express.application[method];
    express.application[method] = function patchedRouteMethod(path, ...handlers) {
      const guarded = handlers.map((handler) => {
        if (typeof handler !== "function" || handler.name !== "requireInternalAccess") return handler;
        return async function supabaseOrInternalAccess(req, res, next) {
          const internalToken = tokenFromRequest(req);
          const configuredInternal = process.env.INTERNAL_ACCESS_TOKEN || "";
          if (internalToken && configuredInternal && internalToken === configuredInternal) return next();
          if (await authorizeSupabaseRequest(req)) return next();
          return res.status(401).json({ error: "Authentication required." });
        };
      });
      return originalRouteMethods[method].call(this, path, ...guarded);
    };
  }
}

const originalListen = express.application.listen;
express.application.listen = function patchedListen(...args) {
  this.get("/api/auth/config", (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!AUTH_CONFIGURED) return res.status(503).json({ error: "Authentication is not configured." });
    res.json({ supabaseUrl: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY });
  });
  return originalListen.apply(this, args);
};

require("./server.js");
