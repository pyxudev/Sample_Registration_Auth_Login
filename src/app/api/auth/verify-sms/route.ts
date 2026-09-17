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
