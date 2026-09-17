"use client";

import { redirect } from "next/navigation";
import { useEffect, useState } from "react";

export default function HomePage() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    async function load() {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      }
    }
    load();
  }, []);

  if (!user) {
    return (
      <main>
        <h1>Welcome</h1>
        <p>You are not logged in.</p>
        <a href="/login" style={{ color: "blue", textDecoration: "underline" }}>
          Go to Login
        </a>
      </main>
    );
  }

  return (
    <main>
      <h1>Hello, { user.name ||user.email ||user.phone ||"User" }</h1>
      <p>You are logged in.</p>
      <button
        style={{
          background: "#ccc",
          color: "black",
          padding: "8px 16px",
          borderRadius: 6,
        }}
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          redirect("/login");
        }}
      >
        Logout
      </button>
    </main>
  );
}
