// Backend-agnostic conversion interface. The Worker only depends on this.
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

export class ConverterError extends Error {
  constructor(message: string, public kind: "failed" | "timeout" | "too_large" | "unsupported" | "invalid_input") {
    super(message);
  }
}

export interface ConverterClient {
  convert(req: ConvertRequest, signal?: AbortSignal): Promise<ConvertResult>;
}
