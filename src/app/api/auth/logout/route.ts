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
