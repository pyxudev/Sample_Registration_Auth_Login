"use client";

import { redirect } from "next/navigation";
import { useState } from "react";
import { registry } from "zod";

export default function LoginPage() {
  const [mode, setMode] = useState<"email" | "phone">("email");

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");

  const [message, setMessage] = useState("");

  async function login() {
    setMessage("");

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        mode === "email"
          ? { email, password }
          : { phone, password }
      ),
    });

    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "Login failed");
      return;
    }

    setMessage("Logged in");
    redirect("/");
  }

  async function registry() {
    redirect("/register");
  }

  return (
    <main>
      <h1>Login</h1>

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

      <button onClick={login}>Login</button>

      <button style={{ marginLeft: 20, background: "#08a62d"}} onClick={registry}>Registry</button>

      {message && <p style={{ marginTop: 16 }}>{message}</p>}
    </main>
  );
}
