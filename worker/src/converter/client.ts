// Backend-agnostic conversion interface. The Worker only depends on this.
import type { SendMethod } from "../matrix/delivery";

/** Synchronous conversion request (POST /convert; local testing / fallback only). */
export interface ConvertRequest {
  fileUrl: string;
  from: string;
  to: string;
  options?: Record<string, unknown>;
}

export interface ConvertResult {
  body: Blob;
  contentType: string;
  filename?: string;
}

/**
 * Asynchronous job (POST /jobs). The converter answers 202 at once, converts in its own
 * queue, uploads the result straight to Telegram and deletes / edits the status message.
 */
export interface JobRequest {
  jobId: string;
  fileUrl: string;
  from: string;
  to: string;
  section: string;
  options: Record<string, string | number | boolean>;
  chatId: number;
  statusMessageId: number;
  replyToMessageId?: number;
  originalName: string;
  delivery: { method: SendMethod; ext: string };
}

export interface JobAccepted {
  jobId: string;
  position: number;
  duplicate?: boolean;
}

export interface SubmitHooks {
  /** Called (at most once) when the converter looks asleep and is probably waking up. */
  onWaking?: () => Promise<void> | void;
}

export type ConverterErrorKind = "failed" | "timeout" | "too_large" | "unsupported" | "invalid_input" | "busy" | "unavailable";

export class ConverterError extends Error {
  constructor(message: string, public kind: ConverterErrorKind) {
    super(message);
  }
}

/** Sync-only client (POST /convert). */
export interface SyncConverterClient {
  convert(req: ConvertRequest, signal?: AbortSignal): Promise<ConvertResult>;
}

/** The interface the bot flow uses. `submitJob` is the default path; `convert` is the sync fallback. */
export interface ConverterClient extends SyncConverterClient {
  submitJob(job: JobRequest, hooks?: SubmitHooks): Promise<JobAccepted>;
}
