// Shared user-facing texts for conversion jobs.
// This file is duplicated byte-for-byte in worker/src/shared/job-messages.ts and
// converter/src/shared/job-messages.ts. A test in each package asserts that the two
// copies are identical, so always edit both together.

export type JobErrorKind = "unsupported" | "too_large" | "timeout" | "invalid_input" | "failed";

export const CONVERTING = "⏳ Converting…";
export const CONVERTER_WAKING = "⏳ Waking up the converter, please wait…";
export const CONVERTER_BUSY = "🚦 The converter is busy right now. Please try again in a minute.";
export const CONVERTER_UNAVAILABLE =
  "😴 The converter is starting up or unavailable right now. Please try again in a minute.";
export const JOB_EXPIRED = "⌛ Sorry, the converter was too busy and your request expired. Please send the file again.";

export const UNSUPPORTED_HTML =
  "❌ This file format is not supported. Send /start to see the list of supported formats.";
export const CONVERSION_FAILED = "❌ Conversion failed. Please try another format or file.";
export const CONVERSION_TIMEOUT = "⌛ Conversion timed out. Please try a smaller file.";
export const INVALID_INPUT =
  "❌ This file can't be converted to that format. It may be damaged, password-protected, or missing the needed content (for example no text, no audio track or no images).";
export const RESULT_TOO_LARGE = "❌ The converted file is larger than 50 MB and can't be sent via Telegram.";

export const ERROR_TEXT: Record<JobErrorKind, string> = {
  unsupported: UNSUPPORTED_HTML,
  too_large: RESULT_TOO_LARGE,
  timeout: CONVERSION_TIMEOUT,
  invalid_input: INVALID_INPUT,
  failed: CONVERSION_FAILED,
};

export function errorText(kind: JobErrorKind | string | undefined): string {
  return ERROR_TEXT[kind as JobErrorKind] ?? CONVERSION_FAILED;
}
