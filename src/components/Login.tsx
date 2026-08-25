import { useState } from "react";
import { supabase, ALLOWED_EMAIL } from "../lib/supabase";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");

    const trimmedEmail = email.trim().toLowerCase();
    if (ALLOWED_EMAIL && trimmedEmail !== ALLOWED_EMAIL) {
      setError("This account is not authorised.");
      return;
    }

    setLoading(true);
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });
    setLoading(false);

    if (authError) {
      setError(authError.message);
    }
  }

  async function handleReset() {
    setError("");
    setInfo("");
    if (!email) {
      setError("Enter your email first");
      return;
    }
    const trimmedEmail = email.trim().toLowerCase();
    if (ALLOWED_EMAIL && trimmedEmail !== ALLOWED_EMAIL) {
      setError("This account is not authorised.");
      return;
    }
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(trimmedEmail);
    if (resetError) {
      setError(resetError.message);
    } else {
      setInfo("Password reset email sent. Check your inbox.");
    }
  }

  return (
    <div className="login-shell">
      <h1>Ledger</h1>
      <p>Sign in to continue.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      {info && <div className="info">{info}</div>}
      <div style={{ marginTop: 12, textAlign: "center" }}>
        <button
          type="button"
          onClick={handleReset}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            fontSize: 13,
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          Forgot password?
        </button>
      </div>
    </div>
  );
}
