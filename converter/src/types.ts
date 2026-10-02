export interface JobContext {
  /** Absolute path of the downloaded input file (inside workDir). */
  input: string;
  /** Private temp dir for this job; deleted after the job. */
  workDir: string;
  from: string;
  to: string;
  options: Record<string, unknown>;
  signal: AbortSignal;
}

export interface JobOutput {
  path: string;
  contentType: string;
  filename: string; // suggested filename (basename only)
}

export type Handler = (ctx: JobContext) => Promise<JobOutput>;

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
