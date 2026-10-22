import { translate } from '@/i18n/i18n'
import { SEARCH_ENGINE_LABELS } from '../../../shared/browser-url'
import type { WorkspaceBrowserTabIntent } from './workspace-browser-tab-open'

// Why: concurrent URL tabs are indistinguishable under a shared "Open URL"
// label until the page title loads; the query string stays out so a typed URL
// does not park credentials or tokens in persisted tab state.
function urlTabTitle(url: string): string | null {
  try {
    // host, not hostname: localhost:3000 and localhost:5173 are different tabs.
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return null
  }
}

export function intentPresentation(
  intent: WorkspaceBrowserTabIntent,
  url: string
): {
  error: string
  title: string
} {
  if (intent.kind === 'url') {
    return {
      error: translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.'),
      title:
        urlTabTitle(url) ??
        translate('auto.components.tab.bar.TabBarCreateEntry.7cdf8ee0c8', 'Open URL')
    }
  }
  const engine = SEARCH_ENGINE_LABELS[intent.engine]
  return {
    error: translate(
      'auto.lib.workspace.browser.tab.open.searchFailed',
      'Unable to search with {{value0}}.',
      { value0: engine }
    ),
    title: translate(
      'auto.components.tab.bar.TabBarCreateEntry.searchProvider',
      'Search {{value0}}',
      { value0: engine }
    )
  }
}

// Why: the UI string stays friendly and query-free, but the diagnosable reason
// rides along as `cause` so a failed open is not indistinguishable in logs.
export function openFailure(message: string, reason: string, cause?: unknown): Error {
  // Why: callers only surface `message`, so log the reason here or a failed open
  // leaves no trace at all. The reason alone — never `cause` — keeps the typed
  // URL and search query out of the console.
  console.warn(`[workspace-browser-tab-open] ${reason}`)
  return new Error(message, {
    cause: new Error(reason, cause === undefined ? undefined : { cause })
  })
}

export function validateTarget(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}
