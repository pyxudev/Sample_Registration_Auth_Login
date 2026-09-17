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
