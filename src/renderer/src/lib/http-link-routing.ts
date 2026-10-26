import {
  localhostLabelRouteForHttpLink,
  openLabeledLocalhostLink,
  type LocalhostLinkRepo,
  type LocalhostLinkProject,
  type LocalhostLinkWorktree
} from './http-link-localhost-route'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

import type { BrowserLinkOpenContext } from './browser-link-destination'
import type { LinkOpenIntent, LinkSourceState } from './link-open-intent'
import { captureLinkOpenIntent, canOpenLinkInSourceGroup } from './link-open-intent'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { reselectWorkspaceKeepingHost } from './active-workspace-host'
import {
  captureBrowserLinkReveal,
  type BrowserLinkSelectionSubscriber
} from './browser-link-reveal'
import {
  isHttpLinkBackgroundOpen,
  openLocalHttpLinkTab,
  prepareRemoteHttpLinkTab,
  type HttpLinkBrowserRequestFields,
  type HttpLinkBrowserTabState
} from './http-link-browser-placement'

export type OpenHttpLinkOptions = {
  worktreeId?: string | null
  /** Terminal-only opt-in for routing a remote-owned source through its managed browser. */
  allowRemoteInApp?: boolean
  /** Unconditional: always use the system browser regardless of settings. */
  forceSystemBrowser?: boolean
  /** Unconditional for local sources: open inside Orca regardless of settings. */
  forceInApp?: boolean
  /** The Shift escape-hatch modifier was held; resolveModifierRouting decides what it means. */
  modifierHeld?: boolean
  sourceOwner?: HttpLinkSourceOwner
  linkContext?: BrowserLinkOpenContext
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

type StoreAccessor = () => HttpLinkStoreState

type WorkspaceHttpLinkBrowserRequest = HttpLinkBrowserRequestFields & {
  workspaceId: string
  url: string
  intent: { kind: 'url' }
  linkContext?: BrowserLinkOpenContext
  expectedRuntimeEnvironmentId?: string
  expectedSshConnectionId?: string
}

/** Resolves to the page id when the page renders on this desktop, else null. */
type WorkspaceHttpLinkBrowserOpener = (
  request: WorkspaceHttpLinkBrowserRequest
) => Promise<string | null | void>

// Inject store access to break editor-slice → HTTP routing → store initialization cycles.
let storeAccessor: StoreAccessor | null = null
let storeSubscriber: BrowserLinkSelectionSubscriber | undefined
let workspaceHttpLinkBrowserOpener: WorkspaceHttpLinkBrowserOpener | null = null

export function registerHttpLinkStoreAccessor(
  fn: StoreAccessor,
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

// Route only external http(s); file/markdown targets stay with resolveMarkdownLinkTarget. Modifier-held resolves the user’s Shift choice; forceSystemBrowser is unconditional.
/** Shift traditionally forces system browser; the inversion setting instead chooses the other destination when system is already default. */
function resolveModifierRouting(
  modifierHeld: boolean,
  openLinksInApp: boolean,
  modifierInverts: boolean
): { wantsOrca: boolean; wantsSystemBrowser: boolean } {
  if (!modifierHeld) {
    return { wantsOrca: false, wantsSystemBrowser: false }
  }
  if (!modifierInverts) {
    return { wantsOrca: false, wantsSystemBrowser: true }
  }
  return { wantsOrca: !openLinksInApp, wantsSystemBrowser: openLinksInApp }
}

function reportHttpLinkBrowserOpenFailure(error: unknown): void {
  toast.error(
    error instanceof Error
      ? error.message
      : translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.')
  )
}

export function openHttpLink(url: string, opts: OpenHttpLinkOptions = {}): void {
  if (opts.linkContext?.isCurrentRequest?.() === false) {
    return
  }
  const {
    worktreeId,
    allowRemoteInApp,
    forceSystemBrowser,
    forceInApp,
    modifierHeld,
    sourceOwner
  } = opts
  if (sourceOwner?.kind === 'unknown') {
    return
  }
  const state = storeAccessor?.()
  const remoteRuntimeActive = Boolean(state?.settings?.activeRuntimeEnvironmentId?.trim())
  const effectiveSourceOwner = sourceOwner
  const sourceIsLocal = effectiveSourceOwner
    ? effectiveSourceOwner.kind === 'local'
    : !remoteRuntimeActive
  const openLinksInApp = state?.settings?.openLinksInApp === true
  const modifier = resolveModifierRouting(
    Boolean(modifierHeld),
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
      const fields = prepareRemoteHttpLinkTab(state, worktreeId)
      const reveal = captureBrowserLinkReveal(
        () => storeAccessor?.() ?? state,
        storeSubscriber,
        opts.linkContext?.canReveal
      )
      void workspaceHttpLinkBrowserOpener({
        workspaceId: worktreeId,
        url,
        intent: { kind: 'url' },
        ...fields,
        linkContext: { linkIntent: null, ...opts.linkContext, canReveal: reveal.canReveal },
        ...(effectiveSourceOwner?.kind === 'runtime'
          ? { expectedRuntimeEnvironmentId: effectiveSourceOwner.runtimeEnvironmentId }
          : effectiveSourceOwner?.kind === 'ssh'
            ? { expectedSshConnectionId: effectiveSourceOwner.connectionId }
            : {})
      })
        .catch(reportHttpLinkBrowserOpenFailure)
        .finally(reveal.dispose)
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
        void workspaceHttpLinkBrowserOpener({
          workspaceId: worktreeId,
          url: chosenUrl,
          intent: { kind: 'url' },
          linkContext: { linkIntent: null, ...opts.linkContext, canReveal: reveal.canReveal },
          ...(isHttpLinkBackgroundOpen(state)
            ? { focusOnCreate: false, selectWorktree: false }
            : {})
        })
          .catch(reportHttpLinkBrowserOpenFailure)
          .finally(reveal.dispose)
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
    void window.api.shell.openUrl(url)
    return
  }
  void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
    if (opts.linkContext?.isCurrentRequest?.() === false) {
      return
    }
    void window.api.shell.openUrl(labeledUrl)
  })
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
