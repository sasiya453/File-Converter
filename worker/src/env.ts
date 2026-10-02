export interface Env {
  SESSIONS: KVNamespace;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  CONVERTER_URL: string;
  CONVERTER_TOKEN: string;
  RATE_LIMIT_PER_MIN?: string;
}
