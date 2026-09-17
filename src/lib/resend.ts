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
