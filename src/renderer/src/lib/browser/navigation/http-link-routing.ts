import { resolveModifierRouting } from './http-link-modifier-routing'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import {
  localhostLabelRouteForHttpLink,
  resolveLabeledLocalhostDisplayUrl,
  openLabeledLocalhostLink,
  type LocalhostLinkRepo,
  type LocalhostLinkProject,
  type LocalhostLinkWorktree
} from './http-link-localhost-route'
import type { WorkspacePortScanResult } from '../../../../../shared/workspace-ports'

import type { LinkOpenIntent, LinkSourceState } from '../../link-open-intent'
import { captureLinkOpenIntent, canOpenLinkInSourceGroup } from '../../link-open-intent'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { isFloatingWorkspaceId } from '../../../../../shared/floating-workspace-worktree'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { reselectWorkspaceKeepingHost } from '../../active-workspace-host'
import {
  captureBrowserLinkReveal,
  type BrowserLinkSelectionSubscriber
} from './browser-link-reveal'
import {
  isHttpLinkBackgroundOpen,
  openLocalHttpLinkTab,
  prepareRemoteHttpLinkTab,
  type HttpLinkBrowserTabState
} from './http-link-browser-placement'

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
      .catch(reportHttpLinkBrowserOpenFailure)
      .finally(reveal.dispose)
    return
  }
  void opening.catch(reportHttpLinkBrowserOpenFailure).finally(reveal.dispose)
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

async function openSystemHttpLink(url: string): Promise<void> {
  try {
    await window.api.shell.openUrl(url)
  } catch {
    reportHttpLinkBrowserOpenFailure(null)
  }
}

export function openHttpLink(url: string, opts: OpenHttpLinkOptions = {}): void {
  // Ownerless legacy callers retain their default-server classification without asserting an owner.
  const ownerlessRemoteActive =
    !opts.sourceOwner && Boolean(storeAccessor?.()?.settings?.activeRuntimeEnvironmentId?.trim())
  executeHttpLink(url, opts, ownerlessRemoteActive)
}

export function openOwnedHttpLink(
  url: string,
  opts: OpenHttpLinkOptions & { sourceOwner: HttpLinkSourceOwner }
): void {
  executeHttpLink(url, opts, false)
}

function executeHttpLink(
  url: string,
  opts: OpenHttpLinkOptions,
  remoteRuntimeActive: boolean
): void {
  if (opts.linkContext?.isCurrentRequest?.() === false) {
    return
  }
  const {
    worktreeId: sourceWorktreeId,
    allowRemoteInApp,
    forceSystemBrowser,
    forceInApp,
    sourceOwner
  } = opts
  const worktreeId =
    opts.floatingWorkspace && sourceOwner?.kind === 'local'
      ? FLOATING_TERMINAL_WORKTREE_ID
      : sourceWorktreeId
  if (sourceOwner?.kind === 'unknown') {
    return
  }
  const state = storeAccessor?.()
  const effectiveSourceOwner = sourceOwner
  const sourceIsLocal = effectiveSourceOwner
    ? effectiveSourceOwner.kind === 'local'
    : !remoteRuntimeActive
  const openLinksInApp = state?.settings?.openLinksInApp === true
  const modifier = resolveModifierRouting(
    Boolean(opts.modifierHeld),
    openLinksInApp,
    state?.settings?.openLinksInAppModifierInverts === true
  )
  const wantsOrca =
    !forceSystemBrowser &&
    !modifier.wantsSystemBrowser &&
    Boolean(worktreeId) &&
    (forceInApp || openLinksInApp || modifier.wantsOrca)

  if (
    wantsOrca &&
    allowRemoteInApp &&
    worktreeId &&
    (effectiveSourceOwner?.kind === 'runtime' ||
      effectiveSourceOwner?.kind === 'ssh' ||
      (!effectiveSourceOwner && remoteRuntimeActive))
  ) {
    if (workspaceHttpLinkBrowserOpener && state) {
      const fields = prepareRemoteHttpLinkTab(
        state,
        opts.floatingWorkspace ? FLOATING_TERMINAL_WORKTREE_ID : worktreeId
      )
      const reveal = captureBrowserLinkReveal(
        () => storeAccessor?.() ?? state,
        storeSubscriber,
        opts.linkContext?.canReveal
      )
      const opening = workspaceHttpLinkBrowserOpener({
        workspaceId: worktreeId,
        ...(opts.floatingWorkspace ? { placementWorkspaceId: FLOATING_TERMINAL_WORKTREE_ID } : {}),
        url,
        intent: { kind: 'url' },
        ...fields,
        linkContext: {
          ...opts.linkContext,
          linkIntent: opts.floatingWorkspace ? null : (opts.linkContext?.linkIntent ?? null),
          canReveal: reveal.canReveal
        },
        ...(opts.allowClientBrowserFallback ? { allowClientBrowserFallback: true } : {}),
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
        opts.onBrowserOpenComplete
      )
    }
    return
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
          workspaceId: worktreeId,
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
    if (!localhostRoute) {
      openLocal(url)
      return
    }
    void openLabeledLocalhostLink(url, localhostRoute, openLocal)
    return
  }

  const localhostRoute = state ? localhostLabelRouteForHttpLink(url, state, sourceOwner) : null
  if (!localhostRoute) {
    void openSystemHttpLink(url)
    return
  }
  void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
    if (opts.linkContext?.isCurrentRequest?.() === false) {
      return
    }
    void openSystemHttpLink(labeledUrl)
  })
}

/** Return the source-owned localhost display URL, or null when labeling is unavailable. */
export function resolveLocalhostHttpLinkDisplayUrl(
  url: string,
  sourceOwner?: HttpLinkSourceOwner
): Promise<string | null> {
  return resolveLabeledLocalhostDisplayUrl(url, storeAccessor?.(), sourceOwner)
}
