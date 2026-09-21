import { translate } from '@/i18n/i18n'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { SEARCH_ENGINE_LABELS, type SearchEngine } from '../../../shared/browser-url'
import type { BrowserClientHostPlacementPreference } from '../../../shared/browser-client-host-placement'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  getClientCreationActionPolicy,
  type ClientCreationActionAvailability
} from './client-creation-action-policy'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from './ssh-workspace-browser-route-eligibility'

export type WorkspaceBrowserTabIntent = { kind: 'url' } | { kind: 'search'; engine: SearchEngine }

export type OpenWorkspaceBrowserTabRequest = {
  workspaceId: string
  targetGroupId?: string
  url: string
  intent: WorkspaceBrowserTabIntent
  /** Keep the caller's current terminal/task surface selected while creating the tab. */
  focusOnCreate?: boolean
  /** Keep the caller's current workspace selected while creating the tab. */
  selectWorktree?: boolean
  expectedRuntimeEnvironmentId?: string
  expectedSshConnectionId?: string
  /** Override placement for links whose pane explicitly requires server ownership. */
  placementPreference?: BrowserClientHostPlacementPreference
}

function isExpectedRuntimeBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string
): boolean {
  if (availability.state !== 'enabled' || workspaceId === FLOATING_TERMINAL_WORKTREE_ID || !route) {
    return false
  }
  const expectedEnvironmentId = expectedRuntimeEnvironmentId.trim()
  const environmentId = route.runtimeEnvironmentId?.trim() || null
  const capabilities =
    state.runtimeStatusByEnvironmentId?.get(expectedEnvironmentId)?.status?.capabilities
  if (
    environmentId !== expectedEnvironmentId ||
    !capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)
  ) {
    return false
  }
  const host = parseExecutionHostId(route.executionHostId)
  return (
    !route.executionHostId ||
    Boolean(host && (host.kind !== 'runtime' || host.environmentId === environmentId))
  )
}

export function canOpenWorkspaceBrowserTabOnRuntime(
  state: AppState,
  workspaceId: string,
  expectedRuntimeEnvironmentId: string
): boolean {
  const availability = getClientCreationActionPolicy(state, workspaceId)['managed-browser']
  const route = resolveWorktreeOperationRoute(state, workspaceId)
  return isExpectedRuntimeBrowserRoute(
    state,
    availability,
    route,
    workspaceId,
    expectedRuntimeEnvironmentId
  )
}

function isExpectedSshBrowserRoute(
  state: AppState,
  availability: ClientCreationActionAvailability,
  route: ReturnType<typeof resolveWorktreeOperationRoute>,
  workspaceId: string,
  expectedSshConnectionId: string
): boolean {
  if (availability.state !== 'enabled' || workspaceId === FLOATING_TERMINAL_WORKTREE_ID || !route) {
    return false
  }
  const expectedTargetId = expectedSshConnectionId.trim()
  const eligibility = resolveSshWorkspaceBrowserRouteEligibility(
    getExecutionHostIdForWorktree(state, workspaceId),
    state.settings
  )
  const host = parseExecutionHostId(route.executionHostId)
  return (
    Boolean(expectedTargetId) &&
    route.runtimeEnvironmentId === null &&
    eligibility?.eligible === true &&
    eligibility.targetId === expectedTargetId &&
    host?.kind === 'ssh' &&
    host.targetId === expectedTargetId
  )
}

export function canOpenWorkspaceBrowserTabOnSsh(
  state: AppState,
  workspaceId: string,
  expectedSshConnectionId: string
): boolean {
  const availability = getClientCreationActionPolicy(state, workspaceId)['managed-browser']
  const route = resolveWorktreeOperationRoute(state, workspaceId)
  return isExpectedSshBrowserRoute(state, availability, route, workspaceId, expectedSshConnectionId)
}

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

function intentPresentation(
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
function openFailure(message: string, reason: string, cause?: unknown): Error {
  // Why: callers only surface `message`, so log the reason here or a failed open
  // leaves no trace at all. The reason alone — never `cause` — keeps the typed
  // URL and search query out of the console.
  console.warn(`[workspace-browser-tab-open] ${reason}`)
  return new Error(message, {
    cause: new Error(reason, cause === undefined ? undefined : { cause })
  })
}

function validateTarget(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}

function createClientBrowserTab(
  state: AppState,
  request: OpenWorkspaceBrowserTabRequest,
  hostId: ExecutionHostId,
  presentation: { error: string; title: string }
): void {
  try {
    state.createBrowserTab(request.workspaceId, request.url, {
      activate: request.focusOnCreate !== false,
      browserRuntimeEnvironmentId: null,
      focusAddressBar: false,
      sessionProfileId:
        state.defaultBrowserSessionProfileIdByHostId[hostId] ??
        state.defaultBrowserSessionProfileId,
      targetGroupId: request.targetGroupId,
      title: presentation.title
    })
  } catch (error) {
    throw openFailure(presentation.error, 'client tab creation rejected', error)
  }
}

function assertManagedBrowserEnabled(
  availability: ClientCreationActionAvailability,
  presentation: { error: string }
): asserts availability is Extract<ClientCreationActionAvailability, { state: 'enabled' }> {
  if (availability.state !== 'enabled') {
    throw openFailure(presentation.error, availability.reason)
  }
}

export async function openWorkspaceBrowserTab(
  request: OpenWorkspaceBrowserTabRequest
): Promise<void> {
  const presentation = intentPresentation(request.intent, request.url)
  if (!validateTarget(request.url)) {
    throw openFailure(presentation.error, 'target is not an http(s) URL')
  }
  const state = useAppStore.getState()
  const availability = getClientCreationActionPolicy(state, request.workspaceId)['managed-browser']
  assertManagedBrowserEnabled(availability, presentation)
  const route = resolveWorktreeOperationRoute(state, request.workspaceId)
  if (!route) {
    throw openFailure(presentation.error, 'no active worktree route')
  }
  const environmentId = route.runtimeEnvironmentId?.trim() || null
  const expectedEnvironmentId =
    request.expectedRuntimeEnvironmentId === undefined
      ? null
      : request.expectedRuntimeEnvironmentId.trim()
  const expectedSshConnectionId =
    request.expectedSshConnectionId === undefined ? null : request.expectedSshConnectionId.trim()
  if (expectedEnvironmentId !== null && expectedSshConnectionId !== null) {
    throw openFailure(presentation.error, 'browser owner assertion is ambiguous')
  }
  if (
    expectedEnvironmentId !== null &&
    !isExpectedRuntimeBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedEnvironmentId
    )
  ) {
    throw openFailure(presentation.error, 'asserted runtime cannot provide this managed browser')
  }
  if (
    expectedSshConnectionId !== null &&
    !isExpectedSshBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedSshConnectionId
    )
  ) {
    throw openFailure(presentation.error, 'asserted SSH connection cannot provide this browser')
  }
  const host = parseExecutionHostId(route.executionHostId)
  if (!environmentId) {
    if (!host || host.kind === 'runtime') {
      throw openFailure(presentation.error, `unresolved client host: ${route.executionHostId}`)
    }
    createClientBrowserTab(state, request, host.id, presentation)
    return
  }
  if (
    route.executionHostId &&
    (!host || (host.kind === 'runtime' && host.environmentId !== environmentId))
  ) {
    throw openFailure(
      presentation.error,
      `host ${route.executionHostId} does not own runtime ${environmentId}`
    )
  }
  // An asserted runtime owns links opened from remote panes; provider policy may describe the
  // viewing client's generic browser surface rather than that pane's execution host.
  if (expectedEnvironmentId === null && availability.provider === 'local-client') {
    const localHostId = host && host.kind !== 'runtime' ? host.id : LOCAL_EXECUTION_HOST_ID
    createClientBrowserTab(state, request, localHostId, presentation)
    return
  }
  let created = false
  try {
    created = await createWebRuntimeSessionBrowserTab({
      worktreeId: request.workspaceId,
      environmentId,
      url: request.url,
      targetGroupId: request.targetGroupId,
      // Owner-pinned links need the host tab published before client reconciliation.
      ...(expectedEnvironmentId !== null ? { waitForRegistration: true } : {}),
      ...(request.placementPreference !== undefined
        ? { placementPreference: request.placementPreference }
        : {}),
      // Why: the tab is opened from this workspace's tab bar, so surface that
      // workspace — otherwise a background worktree looks like nothing happened.
      ...(request.focusOnCreate !== undefined ? { focusOnCreate: request.focusOnCreate } : {}),
      selectWorktree: request.selectWorktree !== false,
      stagedTitle: presentation.title,
      stagedFocusAddressBar: false,
      failureLogMode: 'operation-only'
    })
  } catch (error) {
    throw openFailure(presentation.error, 'runtime browser tab creation failed', error)
  }
  if (!created) {
    throw openFailure(presentation.error, 'runtime browser tab creation was unavailable')
  }
}
