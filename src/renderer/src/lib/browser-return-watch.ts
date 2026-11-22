// A provider's page (GitHub's install, Linear's admin install, Slack's OAuth) ends at Orca Cloud's
// return URL, which saves the result before it answers. A page in Orca's browser landing there, or the
// owner coming back to Orca, means something may have changed: the setup reads now and a little faster
// for a while, instead of waiting for its next slow tick.
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

// Each source's return path on the connector, as Orca Cloud serves it.
const RETURN_PATHS = {
  github: '/github/install/callback',
  linear: '/linear/oauth/callback',
  slack: '/slack/oauth/callback'
} as const

/** The connector's return URL for `source`, from any URL the connector itself serves. */
export function connectorReturnUrl(
  source: keyof typeof RETURN_PATHS,
  connectorUrl: string
): string | null {
  try {
    return `${new URL(connectorUrl).origin}${RETURN_PATHS[source]}`
  } catch {
    return null
  }
}

function landedPages(state: AppState, returnUrl: string): Set<string> {
  const ids = new Set<string>()
  for (const pages of Object.values(state.browserPagesByWorkspace)) {
    for (const page of pages) {
      if (page.url === returnUrl || page.url.startsWith(`${returnUrl}?`)) {
        ids.add(page.id)
      }
    }
  }
  return ids
}

/** Calls `onReturn` whenever a page in Orca's browser arrives at `returnUrl`; returns the stop. */
export function watchBrowserReturn(returnUrl: string, onReturn: () => void): () => void {
  // Pages already there (an old tab) are not a return.
  let landed = landedPages(useAppStore.getState(), returnUrl)
  return useAppStore.subscribe((state, previous) => {
    if (state.browserPagesByWorkspace === previous.browserPagesByWorkspace) {
      return
    }
    const now = landedPages(state, returnUrl)
    const arrived = [...now].some((id) => !landed.has(id))
    landed = now
    if (arrived) {
      onReturn()
    }
  })
}

// After a return, reads come this often for a while; otherwise every SETTLED_MS.
const RETURNED_MS = 1_000
const RETURNED_FOR_MS = 30_000
const SETTLED_MS = 3_000

/**
 * Follows one wait on a provider: `check` runs at once when Orca's browser lands on `returnUrl` or the
 * owner comes back to Orca's window (or a chat in it), and `delay()` is the next tick's wait: short for
 * a while after either, else `settledMs`. `stop` removes every listener.
 */
export function followProviderReturn({
  returnUrl,
  check,
  now = Date.now
}: {
  returnUrl: string | null
  check: () => void
  now?: () => number
}): { delay: (settledMs?: number) => number; stop: () => void } {
  let fastUntil = 0
  const returned = (): void => {
    fastUntil = now() + RETURNED_FOR_MS
    check()
  }
  // The window's focus misses going back to a chat beside Orca's browser.
  const onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof Element && event.target.closest('[data-native-chat-root]')) {
      returned()
    }
  }
  window.addEventListener('focus', returned)
  document.addEventListener('focusin', onFocusIn)
  const stopWatch = returnUrl ? watchBrowserReturn(returnUrl, returned) : null
  return {
    delay: (settledMs = SETTLED_MS) => (now() < fastUntil ? RETURNED_MS : settledMs),
    stop: () => {
      window.removeEventListener('focus', returned)
      document.removeEventListener('focusin', onFocusIn)
      stopWatch?.()
    }
  }
}
