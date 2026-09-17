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
