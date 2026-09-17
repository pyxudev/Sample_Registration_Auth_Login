"use client";

import { redirect } from "next/navigation";
import { useState } from "react";

export default function RegisterPage() {
  const [mode, setMode] = useState<"email" | "phone">("email");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const [step, setStep] = useState<"register" | "verify">("register");
  const [message, setMessage] = useState("");

  async function register() {
    setMessage("");

    try {

      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "email"
            ? { name, email, password }
            : { name, phone, password }
        ),
      });

      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Register failed");
        return;
      }

      // 認証コード送信
      const codeRes = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "email"
            ? { email }
            : { phone }
        ),
      });

      const codeData = await codeRes.json();

      if (!codeRes.ok) {
        setMessage(codeData.error ?? "Failed to send verification code");
        return;
      }

      setStep("verify");
      setMessage("Verification code sent");
    } catch {
      setMessage("Failed. Please try again.");
    }
  }

  async function verify() {
    setMessage("");

    const res = await fetch("/api/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        mode === "email"
          ? { email, code }
          : { phone, code }
      ),
    });

    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "Verification failed");
      return;
    }

    setMessage("Registration complete. You can now login.");
    redirect("/login");
  }

  async function login() {
    redirect("/login");
  }

  return (
    <main>
      <h1>Register</h1>

      {/* ログイン方式切り替え */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => setMode("email")}
          style={{
            background: mode === "email" ? "#0070f3" : "#ccc",
            color: mode === "email" ? "white" : "black",
            padding: "8px 16px",
            borderRadius: 6,
          }}
        >
          Email
        </button>

        <button
          onClick={() => setMode("phone")}
          style={{
            background: mode === "phone" ? "#0070f3" : "#ccc",
            color: mode === "phone" ? "white" : "black",
            padding: "8px 16px",
            borderRadius: 6,
          }}
        >
          Phone
        </button>
      </div>

      {step === "register" && (
        <>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
            />
          </label>

          {mode === "email" ? (
            <label>
              Email
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@example.com"
              />
            </label>
          ) : (
            <label>
              Phone
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+81..."
              />
            </label>
          )}

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
            />
          </label>

          <button onClick={register}>Register</button>

          <button style={{ marginLeft: 20, background: "#08a62d"}} onClick={login}>Login</button>
        </>
      )}

      {step === "verify" && (
        <>
          <label>
            Verification Code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
            />
          </label>

          <button onClick={verify}>Verify</button>
        </>
      )}

      {message && <p style={{ marginTop: 16 }}>{message}</p>}
    </main>
  );
}
