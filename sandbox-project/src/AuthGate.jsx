import React, { useState, useEffect } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";

const C = { bg: "#12182B", card: "#1B2340", line: "#2A3355", text: "#F0EAD8", mute: "#8A93A6", gold: "#B98B3E", err: "#E07A6B", ok: "#7FB88A" };
const input = { width: "100%", boxSizing: "border-box", background: C.bg, border: `1px solid ${C.line}`, color: C.text, borderRadius: 6, padding: "10px 12px", fontSize: 14, fontFamily: "Inter, sans-serif", marginBottom: 12 };

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("signin"); // signin | signup | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!supabaseConfigured) { setReady(true); return undefined; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
        if (!data.session) setMsg({ ok: true, text: "Check your email to confirm your account, then sign in." });
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) throw error;
        setMsg({ ok: true, text: "Password reset link sent — check your email." });
      }
    } catch (err) {
      setMsg({ ok: false, text: err.message || "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <div style={{ background: C.bg, minHeight: "100vh" }} />;

  if (!supabaseConfigured) {
    return (
      <div style={{ background: C.bg, minHeight: "100vh", color: C.text, padding: 40, fontFamily: "Inter, sans-serif" }}>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 500 }}>Almost there</h2>
        <p style={{ color: C.mute, maxWidth: 520 }}>
          Account storage isn't connected yet. Add <code>REACT_APP_SUPABASE_URL</code> and <code>REACT_APP_SUPABASE_ANON_KEY</code> as
          environment variables in Vercel, then redeploy. See SETUP.md.
        </p>
      </div>
    );
  }

  if (session) {
    return children({ user: session.user, onSignOut: () => supabase.auth.signOut() });
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "Inter, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=Inter:wght@400;500;600&display=swap');`}</style>
      <form onSubmit={submit} style={{ width: 360, maxWidth: "100%", background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 28 }}>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: 26, color: C.text, margin: "0 0 4px" }}>Retirement Runway</h1>
        <p style={{ color: C.mute, fontSize: 13, margin: "0 0 20px" }}>
          {mode === "signin" ? "Sign in to open your saved plan." : mode === "signup" ? "Create an account to save your plan." : "Enter your email and we'll send a reset link."}
        </p>
        <input style={input} type="email" required placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode !== "reset" && (
          <input style={input} type="password" required minLength={6} placeholder="Password (6+ characters)" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        {msg && <p style={{ color: msg.ok ? C.ok : C.err, fontSize: 13, margin: "0 0 12px" }}>{msg.text}</p>}
        <button type="submit" disabled={busy} style={{ width: "100%", background: C.gold, color: "#12182B", border: "none", borderRadius: 6, padding: "10px 12px", fontSize: 14, fontWeight: 600, cursor: busy ? "wait" : "pointer", fontFamily: "Inter, sans-serif" }}>
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 12 }}>
          <button type="button" style={{ background: "none", border: "none", padding: 0, color: C.mute, cursor: "pointer", fontSize: 12 }} onClick={() => { setMsg(null); setMode(mode === "signin" ? "signup" : "signin"); }}>
            {mode === "signin" ? "Create an account" : "Back to sign in"}
          </button>
          {mode === "signin" && (
            <button type="button" style={{ background: "none", border: "none", padding: 0, color: C.mute, cursor: "pointer", fontSize: 12 }} onClick={() => { setMsg(null); setMode("reset"); }}>Forgot password?</button>
          )}
        </div>
      </form>
    </div>
  );
}
