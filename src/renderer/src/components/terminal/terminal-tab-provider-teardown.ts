type ClosingProviderTeardown = {
  keys: string[]
  inFlight: Promise<void> | null
  retry: (deadlineMs?: number) => Promise<void>
}

const MAX_RETRYABLE_PROVIDER_TEARDOWNS = 128
const MAX_EVICTED_PROVIDER_TEARDOWN_TAB_IDS = 512
const providerTeardownByClosingTabId = new Map<string, ClosingProviderTeardown>()
const retryableProviderTeardowns = new Set<ClosingProviderTeardown>()
const evictedProviderTeardownTabIds = new Set<string>()
let evictedProviderTeardownOverflowed = false

function failedProviderTeardownProof(): Promise<void> {
  const failure = Promise.reject(new Error('terminal_tab_close_failed'))
  void failure.catch(() => {})
  return failure
}

function clearClosingTabProviderTeardown(entry: ClosingProviderTeardown): void {
  retryableProviderTeardowns.delete(entry)
  for (const tabId of entry.keys) {
    if (providerTeardownByClosingTabId.get(tabId) === entry) {
      providerTeardownByClosingTabId.delete(tabId)
    }
  }
}

function rememberEvictedProviderTeardown(entry: ClosingProviderTeardown): void {
  for (const tabId of entry.keys) {
    evictedProviderTeardownTabIds.delete(tabId)
    evictedProviderTeardownTabIds.add(tabId)
    while (evictedProviderTeardownTabIds.size > MAX_EVICTED_PROVIDER_TEARDOWN_TAB_IDS) {
      const oldestTabId = evictedProviderTeardownTabIds.values().next().value
      if (!oldestTabId) {
        break
      }
      evictedProviderTeardownTabIds.delete(oldestTabId)
      evictedProviderTeardownOverflowed = true
    }
  }
}

function beginClosingTabProviderTeardown(
  entry: ClosingProviderTeardown,
  providerTeardown: Promise<void>
): void {
  retryableProviderTeardowns.delete(entry)
  entry.inFlight = providerTeardown
  for (const tabId of entry.keys) {
    providerTeardownByClosingTabId.set(tabId, entry)
  }
  void providerTeardown.then(
    () => clearClosingTabProviderTeardown(entry),
    () => {
      if (entry.inFlight !== providerTeardown) {
        return
      }
      entry.inFlight = null
      retryableProviderTeardowns.add(entry)
      while (retryableProviderTeardowns.size > MAX_RETRYABLE_PROVIDER_TEARDOWNS) {
        const oldest = retryableProviderTeardowns.values().next().value
        if (!oldest) {
          break
        }
        clearClosingTabProviderTeardown(oldest)
        rememberEvictedProviderTeardown(oldest)
      }
    }
  )
}

export function trackTerminalTabProviderTeardown(
  tabIds: readonly string[],
  providerTeardown: Promise<void>,
  retry: (deadlineMs?: number) => Promise<void>
): void {
  const keys = [...new Set(tabIds)]
  for (const tabId of keys) {
    evictedProviderTeardownTabIds.delete(tabId)
  }
  const entry: ClosingProviderTeardown = {
    keys,
    inFlight: null,
    retry
  }
  beginClosingTabProviderTeardown(entry, providerTeardown)
}

export function getTerminalTabProviderTeardown(
  tabId: string,
  deadlineMs?: number
): Promise<void> | undefined {
  const entry = providerTeardownByClosingTabId.get(tabId)
  if (!entry) {
    return evictedProviderTeardownTabIds.has(tabId) || evictedProviderTeardownOverflowed
      ? failedProviderTeardownProof()
      : undefined
  }
  if (entry.inFlight) {
    return entry.inFlight
  }
  let providerTeardown: Promise<void>
  try {
    providerTeardown = entry.retry(deadlineMs)
  } catch (error) {
    providerTeardown = Promise.reject(error)
  }
  beginClosingTabProviderTeardown(entry, providerTeardown)
  return providerTeardown
}
