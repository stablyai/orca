import { translate } from '@/i18n/i18n'
import { SEARCH_ENGINE_LABELS } from '../../../shared/browser-url'
import type { WorkspaceBrowserTabIntent } from './workspace-browser-tab-open'

// Differentiate concurrent URL tabs before titles load; omit queries so persisted labels cannot retain credentials/tokens.
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

// Keep friendly query-free messages and diagnostic causes, logging only the reason because callers surface message alone and cause could expose typed URLs/queries.
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
