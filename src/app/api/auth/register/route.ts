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
