export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

/**
 * Exponential backoff with "full jitter": a random delay between 0 and
 * min(cap, base * 2^(attempt-1)). The randomness stops a burst of failures
 * from all retrying at the same instant (thundering herd).
 * `attempt` is the number of attempts already made (1 = first failure).
 */
export function backoffDelayMs(attempt: number, { baseMs, capMs }: BackoffOptions, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}
