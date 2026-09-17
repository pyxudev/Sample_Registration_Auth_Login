import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);

  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await query(
    "SELECT id, name, email, phone, is_verified, created_at FROM users WHERE id = $1",
    [auth.userId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  return NextResponse.json({ user: rows[0] });
}
