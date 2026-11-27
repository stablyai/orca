const DEFAULT_MAX_PAGES = 256
const DEFAULT_MAX_PAGES_PER_PARTITION = 64
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000

export type BrowserClientPageRetainedLimits = {
  maxPages: number
  maxPagesPerPartition: number
  attachTimeoutMs: number
}

export function resolveBrowserClientPageRetainedLimits(
  options: Partial<BrowserClientPageRetainedLimits>
): BrowserClientPageRetainedLimits {
  const limits = {
    maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
    maxPagesPerPartition: options.maxPagesPerPartition ?? DEFAULT_MAX_PAGES_PER_PARTITION,
    attachTimeoutMs: options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
  }
  if (
    !Number.isInteger(limits.maxPages) ||
    limits.maxPages < 1 ||
    !Number.isInteger(limits.maxPagesPerPartition) ||
    limits.maxPagesPerPartition < 1 ||
    limits.maxPagesPerPartition > limits.maxPages ||
    !Number.isFinite(limits.attachTimeoutMs) ||
    limits.attachTimeoutMs <= 0
  ) {
    throw new Error('browser_client_page_renderer_registry_limits_invalid')
  }
  return limits
}
