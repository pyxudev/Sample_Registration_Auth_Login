import { redis } from "./redis";

const SESSION_PREFIX = "session:";
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10分

export type SessionData = {
  userId: number;
  lastActivity: number; // timestamp (ms)
};

export async function createSession(userId: number): Promise<string> {
  const sessionId = crypto.randomUUID();
  const now = Date.now();

  const data: SessionData = { userId, lastActivity: now };
  await redis.set(SESSION_PREFIX + sessionId, JSON.stringify(data), {
    PX: SESSION_TIMEOUT_MS,
  });

  return sessionId;
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  const raw = await redis.get(SESSION_PREFIX + sessionId);
  if (!raw) return null;
  return JSON.parse(raw) as SessionData;
}

export async function touchSession(sessionId: string): Promise<void> {
  const data = await getSession(sessionId);
  if (!data) return;
  const now = Date.now();
  data.lastActivity = now;
  await redis.set(SESSION_PREFIX + sessionId, JSON.stringify(data), {
    PX: SESSION_TIMEOUT_MS,
  });
}

export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(SESSION_PREFIX + sessionId);
}
