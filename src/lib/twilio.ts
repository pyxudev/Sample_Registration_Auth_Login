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
