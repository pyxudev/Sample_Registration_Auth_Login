# Sample - Registration - Auth - Login App

## とりあえず実行してみたい場合
### DB(Postgresql、Redis) 立ち上げ
```bash
docker compose up -d
```

### postgres のコンテナ Id 確認
```bash
docker ps -a
```

### スキーマ適用
```bash
docker cp latest_schema.sql <postgre_container_id>:/
docker exec -it <postgre_container_id> bash

# Container 内
psql "postgres://appuser:apppass@localhost:5432/appdb" -f latest_schema.sql
exit

# アプリルートディレクトリ
npm run dev
```

動作確認：`localhost:3000`

## 作成手順を追いたい場合

構想：
- アカウント作成（電話番号登録）
- SMS認証（Twilio）
- ログイン→ユーザー情報表示
- 10分操作なしでタイムアウト（Redisでセッション管理）

## アーキテクチャ概要

Next.js (App Router, TypeScript)

- app/api/.../route.ts で REST API を実装
- フロントはシンプルなフォーム＋ユーザー情報表示ページ

PostgreSQL

- 永続ユーザー情報（id, phone, name など）を保存

Redis

- セッション情報（sessionId, userId, lastActivity）を保存
- 10 分操作なしでセッション失効

JWT

- ペイロードは最小限（sub, sessionId）
- httpOnly + secure Cookie に保存（XSS耐性）

Twilio

- SMS で認証コード送信

セッション戦略

- JWT は「セッション ID の署名付きトークン」として利用
- 実際の状態は Redis に置くことで「即時失効」「アイドルタイムアウト」を実現（JWT単体より安全）

## セキュリティ・品質面のポイント

- **JWT は「セッション ID の署名付きトークン」として利用**
  - 実際の状態は Redis にあり、10分アイドルタイムアウトを Redis TTL + lastActivity で管理
  - JWT 単体の「失効不可」問題を避けつつ、Next.js からはシンプルに扱える形にしています
- **httpOnly + secure Cookie**
  - XSSからトークンを守るため、必ず Cookie で送信
- **最小限のペイロード**
  - `sub` と `sessionId` のみを JWT に入れ、ユーザー情報は DB から取得
- **App Router + Route Handlers**
  - Next.js 13+ の標準的な構成で、将来のバージョンでも保守しやすい形

## Create App

```tsx
# Node 20+ 推奨
npx create-next-app@latest sms-auth-app \
  --typescript \
  --eslint \
  --app \
  --src-dir \
  --import-alias "@/*"

cd sms-auth-app
```

## Install packages

```tsx
npm install pg redis jsonwebtoken bcrypt twilio
npm install -D @types/jsonwebtoken @types/bcrypt
```

pg: PostgreSQL クライアント

redis: Redis クライアント

jsonwebtoken: JWT 生成・検証

bcrypt: パスワードハッシュ（今回は任意）

## Docker で Postgres + Redis 起動

ルートディレクトリに `docker-compose.yml` を作成

```yaml
services:
  postgres:
    image: postgres:16
    restart: always
    environment:
      POSTGRES_USER: appuser
      POSTGRES_PASSWORD: apppass
      POSTGRES_DB: appdb
    ports:
      - "5432:5432"

  redis:
    image: redis:7
    restart: always
    ports:
      - "6379:6379"
```

```bash
docker-compose up -d
```

## .env 設定

`.env.local` を作成

```bash
cp .env .env.local
```

```plaintext
# Postgres
PGHOST=localhost
PGPORT=5432
PGUSER=appuser
PGPASSWORD=apppass
PGDATABASE=appdb

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=change_this_to_a_long_random_string

# Twilio
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+81xxxxxxxxxx

# Cookie
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false
```

## データベーススキーマ

PostgreSQL にユーザーテーブルと SMS 認証コードテーブルを作成
`schema.sql`

```sql
-- users テーブル
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(32) UNIQUE NOT NULL,
  name VARCHAR(128),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- sms_codes テーブル（認証コード管理）
CREATE TABLE IF NOT EXISTS sms_codes (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(32) NOT NULL,
  code VARCHAR(8) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

```bash
docker cp schema.sql <Postgresql_Docker_Id>:/
docker exec -it <Postgresql_Docker_Id> bash
psql "postgres://appuser:apppass@localhost:5432/appdb" -f schema.sql
exit
```

## 共通ライブラリ

`src/lib` 配下にまとめます。

### PostgreSQL クライアント

`db.ts`

```tsx
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

```

### Redis クライアント

`redis.ts`

```tsx
import { createClient } from "redis";

const client = createClient({
  url: process.env.REDIS_URL,
});

client.on("error", (err) => {
  console.error("Redis error", err);
});

if (!client.isOpen) {
  client.connect().catch((err) => {
    console.error("Redis connect error", err);
  });
}

export { client as redis };

```

### JWT ユーティリティ

`jwt.ts`

```tsx
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET!;

export type JwtPayload = {
  sub: number;      // userId
  sessionId: string;
};

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h", // トークン自体の有効期限（例）
  });
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

```

### セッション管理（Redis）

`session.ts`

```tsx
import { redis } from "./redis";

const SESSION_PREFIX = "session:";
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10分

export type SessionData = {
  userId: number;
  lastActivity: number; // timestamp (ms)
};

export async function createSession(userId: number): Promise<string> {
  const sessionId = crypto.randomUUID();
  const now = Date.now();

  const data: SessionData = { userId, lastActivity: now };
  await redis.set(SESSION_PREFIX + sessionId, JSON.stringify(data), {
    PX: SESSION_TIMEOUT_MS,
  });

  return sessionId;
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  const raw = await redis.get(SESSION_PREFIX + sessionId);
  if (!raw) return null;
  return JSON.parse(raw) as SessionData;
}

export async function touchSession(sessionId: string): Promise<void> {
  const data = await getSession(sessionId);
  if (!data) return;
  const now = Date.now();
  data.lastActivity = now;
  await redis.set(SESSION_PREFIX + sessionId, JSON.stringify(data), {
    PX: SESSION_TIMEOUT_MS,
  });
}

export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(SESSION_PREFIX + sessionId);
}

```

### Twilio クライアント

`twilio.ts`

```tsx
import Twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;
const fromNumber = process.env.TWILIO_FROM_NUMBER!;

export const twilioClient = Twilio(accountSid, authToken);

export async function sendSmsCode(phone: string, code: string) {
  await twilioClient.messages.create({
    body: `Your verification code is: ${code}`,
    from: fromNumber,
    to: phone,
  });
}

```

## 認証フロー API 実装

### SMSコード発行（アカウント作成）

`src/app/api/auth/register/route.ts`

```tsx
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { sendSmsCode } from "@/lib/twilio";

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6桁
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const phone: string | undefined = body.phone;
  const name: string | undefined = body.name;

  if (!phone) {
    return NextResponse.json({ error: "phone is required" }, { status: 400 });
  }

  // ユーザーが存在しなければ作成（存在してもOK）
  const existing = await query<{ id: number }>(
    "SELECT id FROM users WHERE phone = $1",
    [phone]
  );

  if (existing.length === 0) {
    await query(
      "INSERT INTO users (phone, name) VALUES ($1, $2)",
      [phone, name || null]
    );
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5分有効

  await query(
    "INSERT INTO sms_codes (phone, code, expires_at) VALUES ($1, $2, $3)",
    [phone, code, expiresAt]
  );

  await sendSmsCode(phone, code);

  return NextResponse.json({ ok: true });
}

```

### SMSコード検証 → セッション発行

`src/app/api/auth/verify-sms/route.ts`

```tsx
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createSession } from "@/lib/session";
import { signJwt } from "@/lib/jwt";

function setAuthCookie(res: NextResponse, token: string) {
  const secure = process.env.COOKIE_SECURE === "true";
  const domain = process.env.COOKIE_DOMAIN || "localhost";

  res.cookies.set("auth_token", token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    domain,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const phone: string | undefined = body.phone;
  const code: string | undefined = body.code;

  if (!phone || !code) {
    return NextResponse.json({ error: "phone and code are required" }, { status: 400 });
  }

  const now = new Date();

  const rows = await query<{
    id: number;
    expires_at: Date;
    used: boolean;
  }>(
    "SELECT id, expires_at, used FROM sms_codes WHERE phone = $1 AND code = $2 ORDER BY created_at DESC LIMIT 1",
    [phone, code]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "invalid code" }, { status: 400 });
  }

  const record = rows[0];

  if (record.used || record.expires_at < now) {
    return NextResponse.json({ error: "code expired or already used" }, { status: 400 });
  }

  // コードを使用済みにする
  await query("UPDATE sms_codes SET used = TRUE WHERE id = $1", [record.id]);

  // ユーザー取得
  const users = await query<{ id: number }>(
    "SELECT id FROM users WHERE phone = $1",
    [phone]
  );

  if (users.length === 0) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const userId = users[0].id;

  // セッション作成
  const sessionId = await createSession(userId);
  const token = signJwt({ sub: userId, sessionId });

  const res = NextResponse.json({ ok: true });
  setAuthCookie(res, token);

  return res;
}

```

## 認証ミドルウェア & ユーザー情報取得

### 認証ヘルパー

`src/lib/auth.ts`

```tsx
import { NextRequest } from "next/server";
import { verifyJwt } from "./jwt";
import { getSession, touchSession } from "./session";

export type AuthContext = {
  userId: number;
  sessionId: string;
};

export async function requireAuth(req: NextRequest): Promise<AuthContext | null> {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return null;

  const payload = verifyJwt(token);
  if (!payload) return null;

  const session = await getSession(payload.sessionId);
  if (!session) return null;

  // 10分アイドルタイムアウトチェック
  const now = Date.now();
  const diff = now - session.lastActivity;
  const timeoutMs = 10 * 60 * 1000;

  if (diff > timeoutMs) {
    // セッションは Redis 側で TTL により消える想定だが、念のため null を返す
    return null;
  }

  // アクセスがあったので更新
  await touchSession(payload.sessionId);

  return {
    userId: session.userId,
    sessionId: payload.sessionId,
  };
}

```

### ユーザー情報取得 API

`src/app/api/auth/me/route.ts`

```tsx
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const users = await query<{
    id: number;
    phone: string;
    name: string | null;
    created_at: Date;
  }>(
    "SELECT id, phone, name, created_at FROM users WHERE id = $1",
    [auth.userId]
  );

  if (users.length === 0) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  return NextResponse.json({ user: users[0] });
}

```

### ログアウト API

`src/app/api/auth/logout/route.ts`

```tsx
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { destroySession } from "@/lib/session";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  const res = NextResponse.json({ ok: true });

  // Cookie削除
  res.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    path: "/",
    domain: process.env.COOKIE_DOMAIN || "localhost",
    maxAge: 0,
  });

  if (auth) {
    await destroySession(auth.sessionId);
  }

  return res;
}

```

## フロントエンド

### トップページ：登録＆ログインフォーム

`src/app/page.tsx`

```tsx
"use client";

import { useState } from "react";

export default function HomePage() {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [user, setUser] = useState<any>(null);
  const [message, setMessage] = useState("");

  async function register() {
    setMessage("");
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, name }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "register failed");
    } else {
      setMessage("SMS code sent");
    }
  }

  async function verify() {
    setMessage("");
    const res = await fetch("/api/auth/verify-sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "verify failed");
    } else {
      setMessage("Logged in");
      await fetchMe();
    }
  }

  async function fetchMe() {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "unauthorized");
      setUser(null);
    } else {
      setUser(data.user);
    }
  }

  async function logout() {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    const data = await res.json();
    setMessage("Logged out");
    setUser(null);
  }

  return (
    <main>
      <h1>SMS Auth Demo</h1>

      <section>
        <h2>Register / Login</h2>
        <label>
          Phone
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+81..."
          />
        </label>

        <label>
          Name (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </label>

        <button onClick={register}>Send SMS Code</button>
      </section>

      <section>
        <h2>Verify SMS</h2>
        <label>
          Code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
          />
        </label>

        <button onClick={verify}>Verify & Login</button>
      </section>

      <section>
        <h2>User Info</h2>
        <button onClick={fetchMe}>Fetch Me</button>
        <button onClick={logout} style={{ marginLeft: 8 }}>
          Logout
        </button>

        {user && (
          <pre style={{ marginTop: 8 }}>
            {JSON.stringify(user, null, 2)}
          </pre>
        )}
      </section>

      {message && <p style={{ marginTop: 16 }}>{message}</p>}
    </main>
  );
}
```

`global.css`

```tsx
@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #171717;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #f5f7fa;
  color: #333;
}

main {
  max-width: 600px;
  margin: 40px auto;
  background: white;
  padding: 32px;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.08);
}

h1 {
  margin-bottom: 24px;
  font-size: 28px;
  text-align: center;
}

section {
  margin-top: 32px;
}

label {
  display: block;
  margin-bottom: 12px;
  font-weight: 600;
}

input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 16px;
  margin-top: 6px;
}

button {
  margin-top: 12px;
  padding: 10px 16px;
  background: #0070f3;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
}

button:hover {
  background: #0059c9;
}

pre {
  background: #f0f0f0;
  padding: 16px;
  border-radius: 8px;
  overflow-x: auto;
}

```

## メールアドレス・パスワードでの認証・ログインもしたい場合

```bash
npm install resend
```

### `.env.lcoal`

```sql
# --- Resend ---
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxx
```

### `schema.sql`

```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(32) UNIQUE,
  password_hash VARCHAR(255),
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS verification_codes (
  id SERIAL PRIMARY KEY,
  identifier VARCHAR(255) NOT NULL, -- email or phone
  code VARCHAR(8) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

すでに最初の `schema.sql` を適用済みの場合は

```sql
ALTER TABLE users
  ADD COLUMN email VARCHAR(255) UNIQUE,
  ADD COLUMN password_hash VARCHAR(255),
  ADD COLUMN is_verified BOOLEAN DEFAULT FALSE
  ALTER COLUMN phone DROP NOT NULL;

CREATE TABLE IF NOT EXISTS verification_codes (
  id SERIAL PRIMARY KEY,
  identifier VARCHAR(255) NOT NULL,
  code VARCHAR(8) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### `src/app/register/page.tsx`

```sql
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

          <button style={{ marginLeft: 20, background: "#08a62d"}} onClick={login}>Login</button>
        </>
      )}

      {message && <p style={{ marginTop: 16 }}>{message}</p>}
    </main>
  );
}
```

### `src/app/api/auth/register/route.ts`

```sql
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import bcrypt from "bcrypt";
import { z } from "zod";

const registerSchema = z
  .object({
    name: z.string(),
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
    password: z.string().min(8),
  })
  .refine(
    (data) => Boolean(data.email) !== Boolean(data.phone),
    {
      message: "Provide either email or phone",
    }
  );

export async function POST(req: NextRequest) {
  console.log("REGISTER API HIT");
  try {
    const body = await req.json();

    const result = registerSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid request" },
        { status: 400 }
      );
    }

    const { name, email, phone, password } = result.data;
    if (name == null || name == undefined || name == "") {
      return NextResponse.json(
        { error: "Invalid request, no name set." },
        { status: 400 }
      );
    }

    const safeEmail = email ?? null;
    const safePhone = phone ?? null;
    console.log("BODY:", { safeEmail, safePhone, password });

    const existing = await query(
      `
      SELECT id
      FROM users
      WHERE
        (email IS NOT NULL AND email = $1)
        OR
        (phone IS NOT NULL AND phone = $2)
      LIMIT 1
      `,
      [safeEmail, safePhone]
    );

    if (existing.length > 0) {
      return NextResponse.json(
        { error: "already registered" },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    console.log("passwordHash:", { passwordHash });
    await query(
      `
      INSERT INTO users (
        name,
        email,
        phone,
        password_hash
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        name,
        safeEmail,
        safePhone,
        passwordHash,
      ]
    );

    return NextResponse.json(
      { ok: true },
      { status: 201 }
    );
  } catch (error) {
    console.error("Register error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

```

### `src/app/api/auth/send-code/route.ts`

```sql
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/resend";
import { sendSmsCode } from "@/lib/twilio";

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function POST(req: NextRequest) {
  const { email, phone } = await req.json();

  const identifier = email || phone;
  if (!identifier) {
    return NextResponse.json({ error: "email or phone required" }, { status: 400 });
  }

  const code = generateCode();
  const expires = new Date(Date.now() + 5 * 60 * 1000);

  await query(
    "INSERT INTO verification_codes (identifier, code, expires_at) VALUES ($1, $2, $3)",
    [identifier, code, expires]
  );

  if (email) {
    await sendVerificationEmail(email, code);
  } else {
    await sendSmsCode(phone, code);
  }

  return NextResponse.json({ ok: true });
}

```

### `src/lib/resend.ts`

```sql
import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY!);

export async function sendVerificationEmail(email: string, code: string) {
  await resend.emails.send({
    from: "Auth System <onboarding@resend.dev>",
    to: email,
    subject: "Your verification code",
    html: `<p>Your verification code is <strong>${code}</strong></p>`
  });
}

```

### `src/app/api/auth/verify-code/route.ts`

```sql
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { email, phone, code } = await req.json();
  const identifier = email || phone;

  const rows = await query(
    "SELECT id, expires_at, used FROM verification_codes WHERE identifier = $1 AND code = $2 ORDER BY created_at DESC LIMIT 1",
    [identifier, code]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "invalid code" }, { status: 400 });
  }

  const record = rows[0];

  if (record.used || record.expires_at < new Date()) {
    return NextResponse.json({ error: "expired or used" }, { status: 400 });
  }

  await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);
  await query("UPDATE users SET is_verified = TRUE WHERE email = $1 OR phone = $2", [email, phone]);

  return NextResponse.json({ ok: true });
}

```

### `src/app/login/page.tsx`

```sql
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

```

### `src/app/api/auth/login/route.ts`

```sql
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import bcrypt from "bcrypt";
import { signJwt } from "@/lib/jwt";
import { createSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  const { email, phone, password } = await req.json();

  const users = await query(
    "SELECT id, password_hash, is_verified FROM users WHERE email = $1 OR phone = $2",
    [email, phone]
  );

  if (users.length === 0) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 400 });
  }

  const user = users[0];

  if (!user.is_verified) {
    return NextResponse.json({ error: "not verified" }, { status: 400 });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 400 });
  }

  const sessionId = await createSession(user.id);
  const token = signJwt({ sub: user.id, sessionId });

  const res = NextResponse.json({ ok: true });

  res.cookies.set("auth_token", token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/"
  });

  return res;
}

```

### `src/app/api/auth/me/route.ts`

```bash
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);

  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await query(
    "SELECT id, email, phone, is_verified, created_at FROM users WHERE id = $1",
    [auth.userId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  return NextResponse.json({ user: rows[0] });
}

```

### `src/app/page.tsx`

```sql
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

```
