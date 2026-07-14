const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

export type UpstreamFetchOptions = RequestInit & {
  timeoutMs?: number;
};

/**
 * Fetch Go API with timeout and without forwarding client Host (avoids proxy loops / bad routing).
 */
export async function upstreamFetch(
  url: string | URL,
  init: UpstreamFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, headers, ...rest } = init;
  const merged = new Headers(headers);

  merged.delete("host");
  merged.delete("connection");
  merged.delete("content-length");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...rest,
      headers: merged,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new UpstreamTimeoutError(String(url), timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class UpstreamTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`upstream request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "UpstreamTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}
