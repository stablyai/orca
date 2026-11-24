import { translate } from '@/i18n/i18n'
import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { SEARCH_ENGINE_LABELS } from '../../../../../shared/browser/navigation/browser-url'
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

/** A failed open: `message` is the friendly copy, `reason` the URL-free cause shown beside it. */
export class WorkspaceBrowserOpenError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    cause?: unknown
  ) {
    super(message, { cause: new Error(reason, cause === undefined ? undefined : { cause }) })
  }
}

// The reason alone (never `cause`) is logged and shown, so a typed URL or search query stays out.
export function openFailure(message: string, reason: string, cause?: unknown): Error {
  console.warn(`[workspace-browser-tab-open] ${reason}`)
  recordRendererCrashBreadcrumb('workspace_browser_tab_open_failed', { reason })
  return new WorkspaceBrowserOpenError(message, reason, cause)
}

/** The toast detail for a failed open, so a report names its cause; null for other errors. */
export function openFailureDetail(error: unknown): string | null {
  return error instanceof WorkspaceBrowserOpenError
    ? translate('auto.lib.workspace.browser.tab.open.failureReason', 'Reason: {{value0}}', {
        value0: error.reason
      })
    : null
}

export function validateTarget(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}
