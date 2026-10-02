import type { Env } from "../env";
import type { ConverterClient } from "./client";
import { HttpConverterClient } from "./http";

export * from "./client";

/** Factory: swap in another adapter (e.g. CloudConvert) here without touching the flow code. */
export function makeConverter(env: Env): ConverterClient {
  return new HttpConverterClient(env.CONVERTER_URL, env.CONVERTER_TOKEN);
}
