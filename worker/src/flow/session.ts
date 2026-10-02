import type { Section } from "../matrix";

export interface Session {
  fileId: string;
  fileName: string;
  source: string;          // detected source format, e.g. "pdf"
  sections: Section[];     // sections in which the source appears
  fileSize?: number;
  createdAt: number;
}

export const SESSION_TTL_SECONDS = 3600;
const key = (chatId: number) => `session:${chatId}`;

export async function saveSession(kv: KVNamespace, chatId: number, s: Session): Promise<void> {
  await kv.put(key(chatId), JSON.stringify(s), { expirationTtl: SESSION_TTL_SECONDS });
}

export async function loadSession(kv: KVNamespace, chatId: number): Promise<Session | null> {
  const raw = await kv.get(key(chatId));
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function clearSession(kv: KVNamespace, chatId: number): Promise<void> {
  await kv.delete(key(chatId));
}
