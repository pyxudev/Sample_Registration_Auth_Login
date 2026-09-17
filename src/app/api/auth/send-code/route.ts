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
