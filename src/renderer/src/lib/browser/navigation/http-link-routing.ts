import {
  isRemoteLoopbackHttpLink,
  localhostLabelRouteForHttpLink,
  openLabeledLocalhostLink
} from './http-link-localhost-route'
import type {
  LocalhostLinkRepo,
  LocalhostLinkProject,
  LocalhostLinkWorktree
} from './http-link-localhost-route'
import {
  captureLinkOpenIntent,
  canOpenLinkInSourceGroup
} from '../../links/placement/link-open-intent'
import type { LinkOpenIntent, LinkSourceState } from '../../links/placement/link-open-intent'
import { translate } from '@/i18n/i18n'
import { isFloatingWorkspaceId } from '../../../../../shared/workspace/identity/floating-workspace-worktree'
import { toast } from 'sonner'
import { reselectWorkspaceKeepingHost } from '../../workspace/ownership/active-workspace-host'
import { captureBrowserLinkReveal } from './browser-link-reveal'
import type { BrowserLinkSelectionSubscriber } from './browser-link-reveal'
import {
  isHttpLinkBackgroundOpen,
  openLocalHttpLinkTab,
  prepareRemoteHttpLinkTab
} from './http-link-browser-placement'
import type { HttpLinkBrowserTabState } from './http-link-browser-placement'
import { resolveModifierRouting } from './http-link-modifier-routing'
import type { WorkspacePortScanResult } from '../../../../../shared/workspace/ports/workspace-ports'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { OpenHttpLinkOptions, WorkspaceHttpLinkBrowserOpener } from './http-link-destinations'
import type { BrowserOpenOutcome } from './browser-link-destination'

function settleHttpLinkBrowserOpen(
  opening: Promise<string | null | void>,
  reveal: { dispose: () => void },
  background: boolean,
  onComplete?: OpenHttpLinkOptions['onBrowserOpenComplete'],
  settle?: (outcome: HttpLinkAdmission) => void
): void {
  // A rejected open settles as failed; a no-op when the detailed outcome already settled it.
  const report = (error: unknown): void => {
    settle?.('failed')
    reportHttpLinkBrowserOpenFailure(error)
  }
  // Openers without a detailed outcome settle from their page id; after a detailed outcome this is a no-op.
  const settleFromPageId = (pageId: string | null | void): void => settle?.(pageId ? 'admitted' : 'refused')
  if (onComplete) {
    void opening
      .then((pageId) => {
        settleFromPageId(pageId)
        onComplete({ pageId: pageId ?? null, background })
      })
      .catch(report)
      .finally(reveal.dispose)
    return
  }
  void opening.then(settleFromPageId).catch(report).finally(reveal.dispose)
}

export type HttpLinkAdmission = 'admitted' | 'refused' | 'failed' | 'superseded'

/** Settles once; a throwing or rejecting consumer must not change how the open is projected. */
export function onceAdmission(
  consumer: ((outcome: HttpLinkAdmission) => void | Promise<void>) | undefined
): (outcome: HttpLinkAdmission) => void {
  let settled = false
  return (outcome) => {
    if (settled || !consumer) {
      settled = true
      return
    }
    settled = true
    try {
      const pending = consumer(outcome)
      if (pending && typeof pending.then === 'function') {
        pending.catch((error: unknown) => console.error('[links] admission consumer failed:', error))
      }
    } catch (error) {
      console.error('[links] admission consumer failed:', error)
    }
  }
}

function admissionForBrowserOutcome(outcome: BrowserOpenOutcome): HttpLinkAdmission {
  if (outcome.status === 'opened') {
    return 'admitted'
  }
  if (outcome.status === 'superseded' || outcome.status === 'failed') {
    return outcome.status
  }
  return 'refused'
}

export type HttpLinkSourceOwner =
  | { kind: 'local' }
  | { kind: 'runtime'; runtimeEnvironmentId: string }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'unknown' }

export type HttpLinkStoreState = HttpLinkBrowserTabState & {
  unifiedTabsByWorktree?: LinkSourceState['unifiedTabsByWorktree']
  groupsByWorktree?: AppState['groupsByWorktree']
  layoutByWorktree?: AppState['layoutByWorktree']
  settings?: Partial<
    Pick<
      GlobalSettings,
      | 'openLinksInAppInBackground'
      | 'openLinksInApp'
      | 'openLinksInAppModifierInverts'
      | 'activeRuntimeEnvironmentId'
      | 'localhostWorktreeLabelsEnabled'
    >
  > | null
  setActiveWorktree: (worktreeId: string, executionHostId?: ExecutionHostId) => void
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  repos?: readonly LocalhostLinkRepo[]
  projects?: readonly LocalhostLinkProject[]
  worktreesByRepo?: Record<string, LocalhostLinkWorktree[]>
  allWorktrees?: () => LocalhostLinkWorktree[]
  workspacePortScan?: { result: WorkspacePortScanResult } | null
  workspacePortScansByKey?: Record<string, WorkspacePortScanResult>
}

export type HttpLinkGroupActionRequest = {
  workspaceId: string
  sourceTabId?: string | null
  url?: string
  sourceOwner?: HttpLinkSourceOwner
}
let groupActionAvailability: ((request: HttpLinkGroupActionRequest) => boolean) | null = null
export function registerHttpLinkGroupActionAvailability(
  check: (request: HttpLinkGroupActionRequest) => boolean
): void {
  groupActionAvailability = check
}

// Inject store access to break editor-slice → HTTP routing → store initialization cycles.
let storeAccessor: (() => HttpLinkStoreState) | null = null
let storeSubscriber: BrowserLinkSelectionSubscriber | undefined
let workspaceHttpLinkBrowserOpener: WorkspaceHttpLinkBrowserOpener | null = null

export function registerHttpLinkStoreAccessor(
  fn: () => HttpLinkStoreState,
  subscribe?: BrowserLinkSelectionSubscriber
): void {
  storeAccessor = fn
  storeSubscriber = subscribe
}

export function registerWorkspaceHttpLinkBrowserOpener(
  fn: WorkspaceHttpLinkBrowserOpener | null
): void {
  workspaceHttpLinkBrowserOpener = fn
}

export function captureHttpLinkIntent(
  workspaceId: string,
  sourceTabId?: string | null,
  explicitSourceGroup = false
): LinkOpenIntent | null {
  const state = storeAccessor?.()
  return state
    ? captureLinkOpenIntent(state, workspaceId, sourceTabId, { explicitSourceGroup })
    : null
}

export function canHttpLinkOpenInSourceGroup(
  workspaceId: string,
  sourceTabId?: string | null,
  url?: string,
  sourceOwner?: HttpLinkSourceOwner
): boolean {
  const state = storeAccessor?.()
  if (
    groupActionAvailability &&
    !groupActionAvailability({ workspaceId, sourceTabId, url, sourceOwner })
  ) {
    return false
  }
  return state ? canOpenLinkInSourceGroup(state, workspaceId, sourceTabId) : false
}

function reportHttpLinkBrowserOpenFailure(error: unknown): void {
  toast.error(
    error instanceof Error
      ? error.message
      : translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.')
  )
}

// Main's shell:openUrl silently ignores anything but http(s); check first so a resolve means it opened.
function isOpenableSystemUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

async function openSystemHttpLink(url: string): Promise<HttpLinkAdmission> {
  if (!isOpenableSystemUrl(url)) {
    return 'refused'
  }
  try {
    await window.api.shell.openUrl(url)
    return 'admitted'
  } catch {
    reportHttpLinkBrowserOpenFailure(null)
    return 'failed'
  }
}

export type HttpLinkDestination = 'orca-browser' | 'system-browser' | 'none'

// Route only external http(s); file/markdown targets stay with resolveMarkdownLinkTarget. Modifier-held resolves the user’s Shift choice; forceSystemBrowser is unconditional.
export function openHttpLink(url: string, opts: OpenHttpLinkOptions = {}): HttpLinkDestination {
  // Ownerless legacy callers retain their default-server classification without asserting an owner.
  const ownerlessRemoteActive =
    !opts.sourceOwner && Boolean(storeAccessor?.()?.settings?.activeRuntimeEnvironmentId?.trim())
  return executeHttpLink(url, opts, ownerlessRemoteActive)
}

export function openOwnedHttpLink(
  url: string,
  opts: OpenHttpLinkOptions & { sourceOwner: HttpLinkSourceOwner }
): HttpLinkDestination {
  return executeHttpLink(url, opts, false)
}

function executeHttpLink(
  url: string,
  opts: OpenHttpLinkOptions,
  remoteRuntimeActive: boolean
): HttpLinkDestination {
  const settle = onceAdmission(opts.onAdmission)
  if (opts.linkContext?.isCurrentRequest?.() === false) {
    settle('superseded')
    return 'none'
  }
  const { worktreeId, allowRemoteInApp, forceSystemBrowser, forceInApp, sourceOwner } = opts
  if (sourceOwner?.kind === 'unknown') {
    settle('refused')
    return 'none'
  }
  const state = storeAccessor?.()
  const onDetailedOutcome = (outcome: BrowserOpenOutcome): void =>
    settle(admissionForBrowserOutcome(outcome))
  const effectiveSourceOwner = sourceOwner
  const sourceIsLocal = effectiveSourceOwner
    ? effectiveSourceOwner.kind === 'local'
    : !remoteRuntimeActive
  const openLinksInApp = state?.settings?.openLinksInApp === true
  // A client fallback tab browses from this desktop, so it cannot reach the owner's loopback either.
  const prefersOrca =
    openLinksInApp ||
    (!opts.allowClientBrowserFallback && isRemoteLoopbackHttpLink(url, effectiveSourceOwner))
  const modifier = resolveModifierRouting(
    Boolean(opts.modifierHeld),
    prefersOrca,
    state?.settings?.openLinksInAppModifierInverts === true
  )
  const wantsOrca =
    !forceSystemBrowser &&
    !modifier.wantsSystemBrowser &&
    Boolean(worktreeId) &&
    (forceInApp || prefersOrca || modifier.wantsOrca)

  if (
    wantsOrca &&
    allowRemoteInApp &&
    worktreeId &&
    (effectiveSourceOwner?.kind === 'runtime' ||
      effectiveSourceOwner?.kind === 'ssh' ||
      (!effectiveSourceOwner && remoteRuntimeActive))
  ) {
    if (workspaceHttpLinkBrowserOpener && state) {
      const fields = prepareRemoteHttpLinkTab(state, worktreeId)
      const reveal = captureBrowserLinkReveal(
        () => storeAccessor?.() ?? state,
        storeSubscriber,
        opts.linkContext?.canReveal
      )
      const opening = workspaceHttpLinkBrowserOpener({
        workspaceId: worktreeId,
        url,
        intent: { kind: 'url' },
        ...fields,
        linkContext: {
          linkIntent: null,
          ...opts.linkContext,
          canReveal: reveal.canReveal,
          onDetailedOutcome
        },
        ...(opts.allowClientBrowserFallback ? { allowClientBrowserFallback: true } : {}),
        // Why: only links that already open in Orca may use a "This device" SSH host's desktop tab.
        ...(openLinksInApp ? { allowSshDeviceBrowser: true } : {}),
        ...(effectiveSourceOwner?.kind === 'runtime'
          ? { expectedRuntimeEnvironmentId: effectiveSourceOwner.runtimeEnvironmentId }
          : effectiveSourceOwner?.kind === 'ssh'
            ? { expectedSshConnectionId: effectiveSourceOwner.connectionId }
            : {})
      })
      settleHttpLinkBrowserOpen(
        opening,
        reveal,
        opts.onBrowserOpenComplete ? isHttpLinkBackgroundOpen(state) : false,
        opts.onBrowserOpenComplete,
        settle
      )
      return 'orca-browser'
    }
    settle('refused')
    return 'none'
  }

  if (wantsOrca && sourceIsLocal && worktreeId && state) {
    const getState = () => storeAccessor?.() ?? state
    const reveal = captureBrowserLinkReveal(getState, storeSubscriber, opts.linkContext?.canReveal)
    const openLocal = (chosenUrl: string): void => {
      if (opts.linkContext?.isCurrentRequest?.() === false) {
        reveal.dispose()
        // No opener runs on this return, so nothing else would settle it.
        settle('superseded')
        return
      }
      if (workspaceHttpLinkBrowserOpener) {
        const opening = workspaceHttpLinkBrowserOpener({
          workspaceId: worktreeId,
          url: chosenUrl,
          intent: { kind: 'url' },
          linkContext: {
            linkIntent: null,
            ...opts.linkContext,
            canReveal: reveal.canReveal,
            onDetailedOutcome
          },
          ...(isHttpLinkBackgroundOpen(state)
            ? { focusOnCreate: false, selectWorktree: false }
            : {})
        })
        settleHttpLinkBrowserOpen(
          opening,
          reveal,
          opts.onBrowserOpenComplete ? isHttpLinkBackgroundOpen(state) : false,
          opts.onBrowserOpenComplete,
          settle
        )
        return
      }
      const activate = !isHttpLinkBackgroundOpen(state) && reveal.canReveal()
      reveal.dispose()
      if (activate && !isFloatingWorkspaceId(worktreeId)) {
        reselectWorkspaceKeepingHost(state, worktreeId)
      }
      openLocalHttpLinkTab(getState(), worktreeId, chosenUrl, undefined, activate)
      settle('admitted')
    }
    const localhostRoute = localhostLabelRouteForHttpLink(url, state, sourceOwner)
    if (localhostRoute) {
      void openLabeledLocalhostLink(url, localhostRoute, openLocal)
    } else {
      openLocal(url)
    }
    return 'orca-browser'
  }

  const localhostRoute = state ? localhostLabelRouteForHttpLink(url, state, sourceOwner) : null
  if (!localhostRoute) {
    void openSystemHttpLink(url).then(settle)
    return 'system-browser'
  }
  void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
    if (opts.linkContext?.isCurrentRequest?.() === false) {
      settle('superseded')
      return
    }
    void openSystemHttpLink(labeledUrl).then(settle)
  })
  return 'system-browser'
}

export async function resolveLocalhostHttpLinkDisplayUrl(
  url: string,
  sourceOwner?: HttpLinkSourceOwner
): Promise<string | null> {
  const state = storeAccessor?.()
  if (!state) {
    return null
  }
  // Resolve hover and click through the same route so remote loopback cannot borrow a local workspace label.
  const localhostRoute = localhostLabelRouteForHttpLink(url, state, sourceOwner)
  if (!localhostRoute) {
    return null
  }
  try {
    const result = await window.api.localhostWorktreeLabels.register(localhostRoute)
    return result.url
  } catch {
    return null
  }
}
