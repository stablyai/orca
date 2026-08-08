import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  parseLoopbackUrlWithPort,
  type LocalhostWorktreeLabelRoute
} from '../../../shared/localhost-worktree-labels'
import type { GlobalSettings } from '../../../shared/types'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'
import { resolveBrowserTabHost } from './browser-tab-host'

export type OpenHttpLinkOptions = {
  worktreeId?: string | null
  /** Unconditional: always use the system browser regardless of settings. */
  forceSystemBrowser?: boolean
  /** The Shift escape-hatch modifier was held; resolveModifierRouting decides what it means. */
  modifierHeld?: boolean
  sourceOwner?: HttpLinkSourceOwner
}

export type HttpLinkSourceOwner =
  | { kind: 'local' }
  | { kind: 'runtime'; runtimeEnvironmentId: string }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'unknown' }

type StoreAccessor = () => {
  settings?: Partial<
    Pick<
      GlobalSettings,
      | 'openLinksInApp'
      | 'openLinksInAppModifierInverts'
      | 'activeRuntimeEnvironmentId'
      | 'localhostWorktreeLabelsEnabled'
      | 'browserTabHost'
    >
  > | null
  setActiveWorktree: (worktreeId: string) => void
  createBrowserTab: (
    worktreeId: string,
    url: string,
    opts: { activate: boolean; browserRuntimeEnvironmentId?: string | null }
  ) => unknown
  repos?: LocalhostLinkRepo[]
  projects?: LocalhostLinkProject[]
  worktreesByRepo?: Record<string, LocalhostLinkWorktree[]>
  allWorktrees?: () => LocalhostLinkWorktree[]
  workspacePortScan?: { result: WorkspacePortScanResult } | null
  workspacePortScansByKey?: Record<string, WorkspacePortScanResult>
}

type LocalhostLinkRepo = {
  id: string
  displayName: string
}

type LocalhostLinkProject = LocalhostLinkRepo

type LocalhostLinkWorktree = {
  id: string
  projectId?: string
}

// Why: store access is injected via registerHttpLinkStoreAccessor rather than
// a direct `import '@/store'` to avoid a circular import — store/slices/editor.ts
// imports this module, and '@/store' transitively imports editor.ts. Without
// the break, several renderer test files that load this module first see
// `createEditorSlice` as undefined at store/index.ts initialization.
let storeAccessor: StoreAccessor | null = null

export function registerHttpLinkStoreAccessor(fn: StoreAccessor): void {
  storeAccessor = fn
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
export function resolveModifierRouting(
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
  const { worktreeId, forceSystemBrowser, modifierHeld, sourceOwner } = opts
  if (sourceOwner?.kind === 'unknown') {
    return
  }
  const state = storeAccessor?.()
  const openLinksInApp = state?.settings?.openLinksInApp === true
  const modifier = resolveModifierRouting(
    Boolean(modifierHeld),
    openLinksInApp,
    state?.settings?.openLinksInAppModifierInverts === true
  )
  const modifierMayOpenInOrca =
    !modifier.wantsOrca ||
    sourceOwner?.kind === 'local' ||
    (!sourceOwner && !state?.settings?.activeRuntimeEnvironmentId?.trim())
  const routeToOrca =
    !forceSystemBrowser &&
    !modifier.wantsSystemBrowser &&
    modifierMayOpenInOrca &&
    Boolean(worktreeId) &&
    (openLinksInApp || modifier.wantsOrca)

  if (routeToOrca && worktreeId && state) {
    const browserOwner = resolveBrowserLinkOwner(state, worktreeId, sourceOwner)
    if (browserOwner.kind === 'runtime') {
      void openRuntimeBrowserLink(url, worktreeId, browserOwner.runtimeEnvironmentId)
      return
    }
    if (browserOwner.kind === 'ssh' || browserOwner.kind === 'unknown') {
      void window.api.shell.openUrl(url)
      return
    }
    // Why: http clicks from inside a worktree should not push a worktree-switch
    // history entry — the user isn't changing worktrees, they're opening a tab
    // in the one they're already in. activateAndRevealWorktree is reserved for
    // file-link jumps that genuinely switch worktrees.
    if (worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
      // Why: the floating workspace uses a synthetic worktree id. Promoting it
      // to the global activeWorktreeId deselects the real repo workspace.
      state.setActiveWorktree(worktreeId)
    }
    const localhostRoute = localhostLabelRouteForHttpLink(url, state, sourceOwner)
    if (!localhostRoute) {
      state.createBrowserTab(worktreeId, url, {
        activate: true,
        browserRuntimeEnvironmentId: null
      })
      return
    }
    void openLabeledLocalhostLink(url, localhostRoute, (labeledUrl) => {
      state.createBrowserTab(worktreeId, labeledUrl, {
        activate: true,
        browserRuntimeEnvironmentId: null
      })
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

/** Applies the explicit tab-host policy without inferring from whichever runtime is focused. */
function resolveBrowserLinkOwner(
  state: ReturnType<StoreAccessor>,
  worktreeId: string,
  sourceOwner?: HttpLinkSourceOwner
): HttpLinkSourceOwner {
  if (resolveBrowserTabHost(state.settings?.browserTabHost) !== 'workspace') {
    return { kind: 'local' }
  }
  if (sourceOwner) {
    return sourceOwner
  }
  const parsed = parseExecutionHostId(
    getExecutionHostIdForWorktree(state as WorktreeRuntimeOwnerState, worktreeId)
  )
  if (parsed?.kind === 'runtime') {
    return { kind: 'runtime', runtimeEnvironmentId: parsed.environmentId }
  }
  if (parsed?.kind === 'ssh') {
    return { kind: 'ssh', connectionId: parsed.targetId }
  }
  return { kind: 'local' }
}

/** Preserves the system-browser escape hatch when runtime capability disappears mid-open. */
async function openRuntimeBrowserLink(
  url: string,
  worktreeId: string,
  runtimeEnvironmentId: string
): Promise<void> {
  try {
    const { createWebRuntimeSessionBrowserTab } = await import('@/runtime/web-runtime-session')
    const created = await createWebRuntimeSessionBrowserTab({
      worktreeId,
      environmentId: runtimeEnvironmentId,
      url
    })
    if (created) {
      return
    }
  } catch {
    // Why: runtime capability can disappear mid-open; preserve the system-browser escape hatch.
  }
  if (typeof window !== 'undefined') {
    void window.api.shell.openUrl(url)
  }
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
  // Why: only loopback links we can attribute to a scanned workspace port
  // should get a worktree label; everything else must stay as-is.
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
