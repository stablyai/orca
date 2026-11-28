import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import {
  isRemoteLoopbackHttpLink,
  openOwnedSystemHttpLink,
  localhostLabelRouteForHttpLink,
  resolveLabeledLocalhostDisplayUrl,
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
import { showBrowserOpenFailure } from '../workspace/workspace-browser-open-failure-toast'
import { isFloatingWorkspaceId } from '../../../../../shared/workspace/identity/floating-workspace-worktree'
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

function settleHttpLinkBrowserOpen(
  opening: Promise<string | null | void>,
  reveal: { dispose: () => void },
  background: boolean,
  onComplete?: OpenHttpLinkOptions['onBrowserOpenComplete']
): void {
  if (onComplete) {
    void opening
      .then((pageId) => onComplete({ pageId: pageId ?? null, background }))
      .catch(showBrowserOpenFailure)
      .finally(reveal.dispose)
    return
  }
  void opening.catch(showBrowserOpenFailure).finally(reveal.dispose)
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

/** The one renderer route to the system browser for an address already resolved for it. */
export async function openSystemHttpLink(url: string): Promise<void> {
  await openSystemHttpLinkReportingOutcome(url)
}

/** openSystemHttpLink for a caller that reports success: false when the launch failed, which it
 *  has already reported. */
export async function openSystemHttpLinkReportingOutcome(url: string): Promise<boolean> {
  try {
    await window.api.shell.openUrl(url)
    return true
  } catch {
    showBrowserOpenFailure(null)
    return false
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

/** Resolve destination policy and source host before opening, revealing, or refusing an HTTP link. */
function executeHttpLink(
  url: string,
  opts: OpenHttpLinkOptions,
  remoteRuntimeActive: boolean
): HttpLinkDestination {
  if (opts.linkContext?.isCurrentRequest?.() === false) {
    return 'none'
  }
  const {
    worktreeId: sourceWorktreeId,
    allowRemoteInApp,
    forceSystemBrowser,
    forceInApp,
    sourceOwner
  } = opts
  const placementWorkspaceId = opts.floatingWorkspace ? FLOATING_TERMINAL_WORKTREE_ID : undefined
  const worktreeId =
    sourceOwner?.kind === 'local' ? (placementWorkspaceId ?? sourceWorktreeId) : sourceWorktreeId
  if (sourceOwner?.kind === 'unknown') {
    return 'none'
  }
  const state = storeAccessor?.()
  const sourceIsLocal = sourceOwner ? sourceOwner.kind === 'local' : !remoteRuntimeActive
  const openLinksInApp = state?.settings?.openLinksInApp === true
  // A client fallback tab browses from this desktop, so it cannot reach the owner's loopback either.
  const prefersOrca =
    openLinksInApp ||
    (!opts.allowClientBrowserFallback &&
      isRemoteLoopbackHttpLink(url, sourceOwner, sourceWorktreeId))
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

  if (wantsOrca && allowRemoteInApp && worktreeId && !sourceIsLocal) {
    if (workspaceHttpLinkBrowserOpener && state) {
      const fields = prepareRemoteHttpLinkTab(state, placementWorkspaceId ?? worktreeId)
      const reveal = captureBrowserLinkReveal(
        () => storeAccessor?.() ?? state,
        storeSubscriber,
        opts.linkContext?.canReveal
      )
      const opening = workspaceHttpLinkBrowserOpener({
        workspaceId: worktreeId,
        placementWorkspaceId,
        url,
        intent: { kind: 'url' },
        ...fields,
        linkContext: {
          ...opts.linkContext,
          linkIntent: opts.floatingWorkspace ? null : (opts.linkContext?.linkIntent ?? null),
          canReveal: reveal.canReveal
        },
        ...(opts.allowClientBrowserFallback ? { allowClientBrowserFallback: true } : {}),
        // Why: only links that already open in Orca may use a "This device" SSH host's desktop tab.
        ...(openLinksInApp ? { allowSshDeviceBrowser: true } : {}),
        ...(sourceOwner?.kind === 'runtime'
          ? { expectedRuntimeEnvironmentId: sourceOwner.runtimeEnvironmentId }
          : sourceOwner?.kind === 'ssh'
            ? { expectedSshConnectionId: sourceOwner.connectionId }
            : {})
      })
      settleHttpLinkBrowserOpen(
        opening,
        reveal,
        opts.onBrowserOpenComplete ? isHttpLinkBackgroundOpen(state) : false,
        opts.onBrowserOpenComplete
      )
      return 'orca-browser'
    }
    return 'none'
  }

  if (wantsOrca && sourceIsLocal && worktreeId && state) {
    const getState = () => storeAccessor?.() ?? state
    const reveal = captureBrowserLinkReveal(getState, storeSubscriber, opts.linkContext?.canReveal)
    const openLocal = (chosenUrl: string): void => {
      if (opts.linkContext?.isCurrentRequest?.() === false) {
        reveal.dispose()
        return
      }
      if (workspaceHttpLinkBrowserOpener) {
        const opening = workspaceHttpLinkBrowserOpener({
          workspaceId: sourceWorktreeId ?? worktreeId,
          placementWorkspaceId,
          url: chosenUrl,
          intent: { kind: 'url' },
          linkContext: {
            ...opts.linkContext,
            linkIntent: opts.floatingWorkspace ? null : (opts.linkContext?.linkIntent ?? null),
            canReveal: reveal.canReveal
          },
          ...(isHttpLinkBackgroundOpen(state)
            ? { focusOnCreate: false, selectWorktree: false }
            : {})
        })
        settleHttpLinkBrowserOpen(
          opening,
          reveal,
          opts.onBrowserOpenComplete ? isHttpLinkBackgroundOpen(state) : false,
          opts.onBrowserOpenComplete
        )
        return
      }
      const activate = !isHttpLinkBackgroundOpen(state) && reveal.canReveal()
      reveal.dispose()
      if (activate && !isFloatingWorkspaceId(worktreeId)) {
        reselectWorkspaceKeepingHost(state, worktreeId)
      }
      openLocalHttpLinkTab(getState(), worktreeId, chosenUrl, undefined, activate)
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
    openOwnedSystemHttpLink(url, sourceOwner, sourceWorktreeId, openSystemHttpLink)
    return 'system-browser'
  }
  void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
    if (opts.linkContext?.isCurrentRequest?.() === false) {
      return
    }
    void openSystemHttpLink(labeledUrl)
  })
  return 'system-browser'
}

/** Return the source-owned localhost display URL, or null when labeling is unavailable. */
export function resolveLocalhostHttpLinkDisplayUrl(
  url: string,
  sourceOwner?: HttpLinkSourceOwner
): Promise<string | null> {
  return resolveLabeledLocalhostDisplayUrl(url, storeAccessor?.(), sourceOwner)
}
