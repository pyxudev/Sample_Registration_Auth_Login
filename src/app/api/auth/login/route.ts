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
