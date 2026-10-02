import type { Env } from "../env";
import type { ConverterClient } from "./client";
import { AsyncJobClient } from "./async";

export * from "./client";
export { AsyncJobClient } from "./async";
export { HttpConverterClient } from "./http";

/** Factory: swap in another adapter (e.g. CloudConvert) here without touching the flow code. */
export function makeConverter(env: Env): ConverterClient {
  return new AsyncJobClient(env.CONVERTER_URL, env.CONVERTER_TOKEN);
}
