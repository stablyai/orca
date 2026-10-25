import { translate } from '@/i18n/i18n'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import {
  parseLoopbackUrlWithPort,
  type LocalhostWorktreeLabelRoute
} from '../../../shared/localhost-worktree-labels'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'
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
}

export type HttpLinkSourceOwner =
  | { kind: 'local' }
  | { kind: 'runtime'; runtimeEnvironmentId: string }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'unknown' }

type StoreAccessor = () => HttpLinkBrowserTabState & {
  settings?: Partial<
    Pick<
      GlobalSettings,
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

type WorkspaceHttpLinkBrowserRequest = HttpLinkBrowserRequestFields & {
  workspaceId: string
  url: string
  intent: { kind: 'url' }
  expectedRuntimeEnvironmentId?: string
  expectedSshConnectionId?: string
}

/** Resolves to the page id when the page renders on this desktop, else null. */
type WorkspaceHttpLinkBrowserOpener = (
  request: WorkspaceHttpLinkBrowserRequest
) => Promise<string | null>

type LocalhostLinkRepo = {
  id: string
  displayName: string
}

type LocalhostLinkProject = LocalhostLinkRepo

type LocalhostLinkWorktree = {
  id: string
  projectId?: string
}

// Inject store access to break editor-slice → HTTP routing → store initialization cycles.
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

export function openHttpLink(url: string, opts: OpenHttpLinkOptions = {}): void {
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
        ...(effectiveSourceOwner?.kind === 'runtime'
          ? { expectedRuntimeEnvironmentId: effectiveSourceOwner.runtimeEnvironmentId }
          : effectiveSourceOwner?.kind === 'ssh'
            ? { expectedSshConnectionId: effectiveSourceOwner.connectionId }
            : {})
      }).then(
        (pageId) => focusHttpLinkPage(fields.focusOnCreate === false ? null : pageId),
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
    // Opening a tab in the same worktree must not add switch history; reserve activateAndRevealWorktree for real file-link jumps.
    if (!isHttpLinkBackgroundOpen(state) && !isFloatingWorkspaceId(worktreeId)) {
      // Floating workspace IDs are synthetic; global activation would deselect the real repo workspace.
      reselectWorkspaceKeepingHost(state, worktreeId)
    }
    const localhostRoute = localhostLabelRouteForHttpLink(url, state, sourceOwner)
    if (!localhostRoute) {
      openLocalHttpLinkTab(state, worktreeId, url)
      return
    }
    // Why placed now: the clicked pane is the active group only until the user clicks elsewhere.
    const placement = resolveHttpLinkBrowserPlacement(state, worktreeId)
    void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
      openLocalHttpLinkTab(storeAccessor?.() ?? state, worktreeId, labeledUrl, placement)
    })
    return
  }

  const localhostRoute = state ? localhostLabelRouteForHttpLink(url, state, sourceOwner) : null
  if (!localhostRoute) {
    void window.api.shell.openUrl(url)
    return
  }
  void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
    void window.api.shell.openUrl(labeledUrl)
  })
}

function localhostLabelRouteForHttpLink(
  url: string,
  state: ReturnType<StoreAccessor>,
  sourceOwner?: HttpLinkSourceOwner
): LocalhostWorktreeLabelRoute | null {
  if (sourceOwner && sourceOwner.kind !== 'local') {
    return null
  }
  if (!sourceOwner && state.settings?.activeRuntimeEnvironmentId?.trim()) {
    return null
  }
  const sourceScan =
    sourceOwner?.kind === 'local'
      ? (state.workspacePortScansByKey?.['local:all'] ?? null)
      : undefined
  return localhostLabelRouteForTerminalLink(url, state, sourceOwner?.kind === 'local', sourceScan)
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

async function openLabeledLocalhostLink(
  fallbackUrl: string,
  route: LocalhostWorktreeLabelRoute,
  open: (url: string) => void
): Promise<void> {
  try {
    const result = await window.api.localhostWorktreeLabels.register(route)
    open(result.url)
  } catch {
    open(fallbackUrl)
  }
}

function localhostLabelRouteForTerminalLink(
  rawUrl: string,
  state: ReturnType<StoreAccessor>,
  ignoreActiveRuntime = false,
  sourceScan?: WorkspacePortScanResult | null
): LocalhostWorktreeLabelRoute | null {
  if (
    state.settings?.localhostWorktreeLabelsEnabled !== true ||
    (!ignoreActiveRuntime && state.settings?.activeRuntimeEnvironmentId?.trim())
  ) {
    return null
  }
  // Label only scanned workspace loopback ports; leave unattributed URLs unchanged.
  const parsed = parseLoopbackUrlWithPort(rawUrl)
  if (!parsed) {
    return null
  }
  const scan = sourceScan === undefined ? state.workspacePortScan?.result : sourceScan
  const port = findWorkspacePortByNumber(scan, Number(parsed.port))
  if (!port) {
    return null
  }
  const repo = state.repos?.find((entry) => entry.id === port.owner.repoId) ?? null
  if (!repo) {
    return null
  }
  const worktree = findWorktreeById(state, port.owner.worktreeId)
  const project =
    worktree?.projectId && state.projects
      ? (state.projects.find((entry) => entry.id === worktree.projectId) ?? null)
      : null
  const projectSource = project ?? repo
  return {
    targetUrl: parsed.toString(),
    projectName: projectSource.displayName,
    worktreeName: port.owner.displayName,
    worktreePath: port.owner.path,
    repoId: repo.id,
    worktreeId: port.owner.worktreeId
  }
}

function findWorkspacePortByNumber(
  scan: WorkspacePortScanResult | null | undefined,
  portNumber: number
): (WorkspacePort & { kind: 'workspace' }) | null {
  const port =
    scan?.ports.find(
      (candidate): candidate is WorkspacePort & { kind: 'workspace' } =>
        candidate.kind === 'workspace' && candidate.port === portNumber
    ) ?? null
  return port
}

function findWorktreeById(
  state: ReturnType<StoreAccessor>,
  worktreeId: string
): LocalhostLinkWorktree | null {
  const fromAllWorktrees = state.allWorktrees?.().find((worktree) => worktree.id === worktreeId)
  if (fromAllWorktrees) {
    return fromAllWorktrees
  }
  const worktreesByRepo = state.worktreesByRepo ?? {}
  for (const worktrees of Object.values(worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    if (worktree) {
      return worktree
    }
  }
  return null
}
