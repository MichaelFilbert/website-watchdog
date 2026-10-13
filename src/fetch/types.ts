export interface FetchedPage {
  /** Raw visible text, not yet normalised. */
  text: string;
  method: 'playwright' | 'http';
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
  close(): Promise<void>;
}
