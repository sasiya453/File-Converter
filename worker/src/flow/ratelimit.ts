/** Fixed-window per-user limiter backed by KV (best-effort; KV is eventually consistent). */
export async function checkRateLimit(kv: KVNamespace, userId: number, limit: number, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / 60_000);
  const k = `rl:${userId}:${window}`;
  const current = Number((await kv.get(k)) ?? "0");
  if (current >= limit) return false;
  await kv.put(k, String(current + 1), { expirationTtl: 120 }); // KV min TTL is 60s
  return true;
}
