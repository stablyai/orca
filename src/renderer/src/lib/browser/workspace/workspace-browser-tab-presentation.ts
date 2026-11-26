import { translate } from '@/i18n/i18n'
import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { browserCreateFailureCode } from '@/runtime/browser/creation/web-runtime-browser-create-failure-code'
import type { WebRuntimeBrowserCreationFailureInfo } from '@/runtime/browser/creation/web-runtime-browser-creation-context'
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

/** What a failed open tells the user beside its title; tokens stay raw, the rest is localized. */
export type OpenFailureDisplay =
  | { kind: 'host-error'; stage: string; code: string | null }
  | { kind: 'host-unavailable' }
  | { kind: 'link-blocked' }
  | { kind: 'not-web-link' }

/** A failed open: `message` is the title, `reason` the URL-free cause for logs, `display` its toast line. */
export class WorkspaceBrowserOpenError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly display: OpenFailureDisplay | null,
    cause?: unknown
  ) {
    super(message, { cause: new Error(reason, cause === undefined ? undefined : { cause }) })
  }
}

// The reason alone (never `cause`) is logged, so a typed URL or search query stays out.
export function openFailure(
  message: string,
  reason: string,
  cause?: unknown,
  display: OpenFailureDisplay | null = null
): Error {
  console.warn(`[workspace-browser-tab-open] ${reason}`)
  recordRendererCrashBreadcrumb('workspace_browser_tab_open_failed', { reason })
  return new WorkspaceBrowserOpenError(message, reason, display, cause)
}

export const NOT_WEB_LINK: OpenFailureDisplay = { kind: 'not-web-link' }

export function hostUnavailableFailure(message: string, reason: string): Error {
  return openFailure(message, reason, undefined, { kind: 'host-unavailable' })
}

export function clientCreateFailure(message: string, cause: unknown): Error {
  return openFailure(message, 'client tab creation rejected', cause, {
    kind: 'host-error',
    stage: 'create',
    code: 'client_create_rejected'
  })
}

export function routeFailure(message: string, reason: string, code: string): Error {
  return openFailure(message, reason, undefined, { kind: 'host-error', stage: 'route', code })
}

/** A remote open's failure from its first error's stage and code; a recorded null code stays null. */
export function remoteOpenFailure(
  message: string,
  failure: WebRuntimeBrowserCreationFailureInfo | null,
  error: unknown
): Error {
  // Why not `??`: the thrown error may be cleanup's, which must not lend its code to the first one.
  const code = failure ? failure.code : browserCreateFailureCode(error)
  const stage = failure?.stage ?? 'open'
  return openFailure(
    message,
    `remote browser open failed at ${stage} (${code ?? 'no code'})`,
    error ?? undefined,
    { kind: 'host-error', stage, code }
  )
}

/** The toast's one-line cause for a failed open, so a report names it; null when there is none. */
export function openFailureDetail(error: unknown): string | null {
  const display = error instanceof WorkspaceBrowserOpenError ? error.display : null
  switch (display?.kind) {
    case 'host-error':
      return translate(
        'auto.lib.workspace.browser.tab.open.failure.stageError',
        'Error · {{value0}} · {{value1}}',
        {
          value0: display.stage,
          // Logs keep other_code; a user can't act on it, so the toast says unknown.
          value1: display.code && display.code !== 'other_code' ? display.code : 'unknown'
        }
      )
    case 'host-unavailable':
      return translate(
        'auto.lib.workspace.browser.tab.open.failure.hostNotFound',
        "Workspace's computer wasn't found."
      )
    case 'link-blocked':
      return translate(
        'auto.lib.workspace.browser.tab.open.failure.linkBlocked',
        'Link open was blocked.'
      )
    case 'not-web-link':
      return translate('auto.lib.workspace.browser.tab.open.failure.notWebLink', 'Not a web link.')
    case undefined:
      return null
  }
}

export function validateTarget(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}
