/** Thrown by a job handler when retrying cannot help (bad input, refusal, 4xx). Goes straight to dead-letter. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

/** Thrown when a dependency told us when to come back (e.g. 429 Retry-After). */
export class RetryLaterError extends Error {
  override name = 'RetryLaterError';
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
  }
}
