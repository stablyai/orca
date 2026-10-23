import {
  localhostLabelRouteForHttpLink,
  openLabeledLocalhostLink,
  type LocalhostLinkRepo,
  type LocalhostLinkProject,
  type LocalhostLinkWorktree
} from './http-link-localhost-route'
import type { BrowserLinkOpenContext } from './browser-link-destination'
import type { LinkOpenIntent, LinkSourceState } from './link-open-intent'
import { captureLinkOpenIntent, canOpenLinkInSourceGroup } from './link-open-intent'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { reselectWorkspaceKeepingHost } from './active-workspace-host'
import {
  focusHttpLinkPage,
  isHttpLinkBackgroundOpen,
  openLocalHttpLinkTab,
  prepareRemoteHttpLinkTab,
  resolveHttpLinkBrowserPlacement,
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

// Why: store access is injected via registerHttpLinkStoreAccessor rather than
// a direct `import '@/store'` to avoid a circular import — store/slices/editor.ts
// imports this module, and '@/store' transitively imports editor.ts. Without
// the break, several renderer test files that load this module first see
// `createEditorSlice` as undefined at store/index.ts initialization.
let storeAccessor: StoreAccessor | null = null
let workspaceHttpLinkBrowserOpener: WorkspaceHttpLinkBrowserOpener | null = null

export function registerHttpLinkStoreAccessor(fn: StoreAccessor): void {
  storeAccessor = fn
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
    ? captureLinkOpenIntent(
        { unifiedTabsByWorktree: state.unifiedTabsByWorktree ?? {} },
        workspaceId,
        sourceTabId,
        { explicitSourceGroup }
      )
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
  return state
    ? canOpenLinkInSourceGroup(
        {
          unifiedTabsByWorktree: state.unifiedTabsByWorktree ?? {},
          groupsByWorktree: state.groupsByWorktree ?? {},
          layoutByWorktree: state.layoutByWorktree ?? {}
        },
        workspaceId,
        sourceTabId
      )
    : false
}

// Scope: http(s) URLs only. file: URIs and in-worktree markdown targets are
// owned by resolveMarkdownLinkTarget and must stay on that path — this helper
// is only invoked on target.kind === 'external' (and for the terminal's http
// branch). Shift+Cmd/Ctrl is the escape hatch: click handlers pass modifierHeld
// so resolveModifierRouting applies it; forceSystemBrowser stays reserved for
// callers that must bypass the setting unconditionally.
/**
 * Resolves what the Shift modifier means for one click. Historically it always
 * forced the system browser, which is a no-op when that is already the default;
 * openLinksInAppModifierInverts makes it flip whichever way Link Routing points
 * so the other destination is always one click away.
 */
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
      void workspaceHttpLinkBrowserOpener({
        workspaceId: worktreeId,
        url,
        intent: { kind: 'url' },
        ...fields,
        ...(opts.linkContext ? { linkContext: opts.linkContext } : {}),
        ...(effectiveSourceOwner?.kind === 'runtime'
          ? { expectedRuntimeEnvironmentId: effectiveSourceOwner.runtimeEnvironmentId }
          : effectiveSourceOwner?.kind === 'ssh'
            ? { expectedSshConnectionId: effectiveSourceOwner.connectionId }
            : {})
      }).then(
        (pageId) => focusHttpLinkPage(fields.focusOnCreate === false ? null : (pageId ?? null)),
        (error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.')
          )
        }
      )
    }
    return
  }

  if (wantsOrca && sourceIsLocal && worktreeId && state) {
    const placement = resolveHttpLinkBrowserPlacement(state, worktreeId)
    const openLocal = (chosenUrl: string): void => {
      if (opts.linkContext?.isCurrentRequest?.() === false) {
        return
      }
      if (opts.linkContext && workspaceHttpLinkBrowserOpener) {
        void workspaceHttpLinkBrowserOpener({
          workspaceId: worktreeId,
          url: chosenUrl,
          intent: { kind: 'url' },
          linkContext: opts.linkContext,
          ...(isHttpLinkBackgroundOpen(state)
            ? { focusOnCreate: false, selectWorktree: false }
            : {})
        }).catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.')
          )
        })
        return
      }
      if (!isHttpLinkBackgroundOpen(state) && !isFloatingWorkspaceId(worktreeId)) {
        reselectWorkspaceKeepingHost(state, worktreeId)
      }
      openLocalHttpLinkTab(storeAccessor?.() ?? state, worktreeId, chosenUrl, placement)
    }
    const localhostRoute = localhostLabelRouteForHttpLink(url, state, sourceOwner)
    if (!localhostRoute) {
      openLocal(url)
      return
    }
    void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
      openLocal(labeledUrl)
    })
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
  // Why: the hover label must resolve the same route the click will take, or a
  // remote pane's loopback URL gets shown with a local worktree's label.
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
