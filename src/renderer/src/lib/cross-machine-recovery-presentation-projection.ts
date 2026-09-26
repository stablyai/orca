import type {
  RecoveryBrowser,
  RecoveryEditor,
  RecoveryLayout,
  RecoveryPresentationFocus,
  RecoveryTerminalLayout
} from '../../../shared/cross-machine-recovery-descriptor'
import {
  MAX_RECOVERY_PRESENTATION_PUBLISH_BYTES,
  MAX_RECOVERY_PRESENTATION_WORKSPACES,
  MAX_RECOVERY_PRESENTATION_WORKSPACE_VIEW_BYTES,
  type RecoveryPresentationInput,
  type RecoveryPresentationWorkspace,
  type RecoveryPresentationWorkspaceRef
} from '../../../shared/cross-machine-recovery-presentation-types'
import { sanitizeTerminalTabForRecovery } from '../../../shared/cross-machine-recovery-session-projection'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../shared/terminal-tab-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { sessionPartitionHostFor } from './workspace-session-host-contention'
import type { HostIdByWorktreeId } from './workspace-session-host-split'

const MAX_BROWSERS_PER_VIEW = 64
const MAX_PAGES_PER_BROWSER = 256
// Why: leaves room for the publish envelope (client id, name, revision) inside the host's cap.
const PUBLISH_ENVELOPE_RESERVE_BYTES = 8 * 1024

export type PresentationWorkspaceCatalog = {
  pathFor: (sessionKey: string) => string | null
  instanceIdFor: (worktreeId: string) => string | undefined
}

export type PresentationProjectionInput = {
  session: WorkspaceSessionState
  hostIdByWorktreeId: HostIdByWorktreeId
  catalog: PresentationWorkspaceCatalog
  windowFocused: boolean
  inputFor: (sessionKey: string, activeSessionKey: string | null) => RecoveryPresentationInput
}

export type HostPresentationSnapshot = {
  workspaces: RecoveryPresentationWorkspace[]
  /** Set when caps dropped workspaces or trimmed views. */
  truncated: boolean
}

type Candidate = { key: string; entry: RecoveryPresentationWorkspace }

const utf8 = new TextEncoder()

function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength
}

/** Session key of the workspace the window shows: folder workspaces use their workspace key. */
export function activePresentationSessionKey(
  session: Pick<WorkspaceSessionState, 'activeWorkspaceKey' | 'activeWorktreeId'>
): string | null {
  const scope = session.activeWorkspaceKey ? parseWorkspaceKey(session.activeWorkspaceKey) : null
  return scope?.type === 'folder' ? (session.activeWorkspaceKey ?? null) : session.activeWorktreeId
}

/** Pane key for a terminal leaf, or null when either id predates stable pane ids. */
export function presentationPaneKey(
  terminalTabId: string | null,
  leafId: string | null | undefined
): string | null {
  return terminalTabId && leafId && isValidTerminalTabId(terminalTabId) && isTerminalLeafId(leafId)
    ? makePaneKey(terminalTabId, leafId)
    : null
}

function workspaceRef(
  key: string,
  catalog: PresentationWorkspaceCatalog
): RecoveryPresentationWorkspaceRef {
  const scope = parseWorkspaceKey(key)
  if (scope?.type === 'folder') {
    return { kind: 'folder', folderWorkspaceId: scope.folderWorkspaceId }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : key
  const instanceId = catalog.instanceIdFor(worktreeId)
  return instanceId
    ? { kind: 'worktree', worktreeId, instanceId }
    : { kind: 'worktree', worktreeId }
}

function presentationSessionKeys(session: WorkspaceSessionState): string[] {
  const keys = new Set<string>()
  for (const record of [
    session.unifiedTabs,
    session.tabsByWorktree,
    session.openFilesByWorktree,
    session.browserTabsByWorktree
  ]) {
    for (const [key, entries] of Object.entries(record ?? {})) {
      if (entries.length > 0) {
        keys.add(key)
      }
    }
  }
  return [...keys]
}

function projectTerminalLayouts(
  session: WorkspaceSessionState,
  terminalTabIds: string[]
): Record<string, RecoveryTerminalLayout> {
  const layouts: Record<string, RecoveryTerminalLayout> = {}
  for (const tabId of terminalTabIds) {
    const snapshot = session.terminalLayoutsByTabId[tabId]
    if (!snapshot) {
      continue
    }
    layouts[tabId] = {
      root: snapshot.root,
      activeLeafId: snapshot.activeLeafId,
      expandedLeafId: snapshot.expandedLeafId,
      ...(snapshot.chatLeafId !== undefined ? { chatLeafId: snapshot.chatLeafId } : {}),
      ...(snapshot.titlesByLeafId ? { titlesByLeafId: snapshot.titlesByLeafId } : {})
    }
  }
  return layouts
}

function projectBrowsers(session: WorkspaceSessionState, key: string): RecoveryBrowser[] {
  return (session.browserTabsByWorktree?.[key] ?? [])
    .slice(0, MAX_BROWSERS_PER_VIEW)
    .map((browser) => ({
      id: browser.id,
      ...(browser.label ? { label: browser.label } : {}),
      activePageId: browser.activePageId ?? null,
      pages: (session.browserPagesByWorkspace?.[browser.id] ?? [])
        .filter((page) => page.url.length > 0)
        .slice(0, MAX_PAGES_PER_BROWSER)
        .map((page) => ({
          id: page.id,
          url: page.url,
          ...(page.title ? { title: page.title } : {})
        }))
    }))
}

/** One workspace's client view: layout only — no scrollback, drafts, or browser history. */
export function projectPresentationView(
  session: WorkspaceSessionState,
  key: string,
  workspacePath: string | null
): RecoveryLayout {
  const terminalTabs = (session.tabsByWorktree[key] ?? []).map(sanitizeTerminalTabForRecovery)
  const startupCwdRelative: Record<string, string> = {}
  for (const tab of terminalTabs) {
    const relative =
      tab.startupCwd && workspacePath ? relativePathInsideRoot(workspacePath, tab.startupCwd) : null
    if (relative !== null) {
      startupCwdRelative[tab.id] = relative
    }
  }
  const files = (session.openFilesByWorktree?.[key] ?? []).filter(
    (file) =>
      !file.externalSshTargetId &&
      file.relativePath.length > 0 &&
      workspacePath !== null &&
      relativePathInsideRoot(workspacePath, file.filePath) !== null
  )
  const editors: RecoveryEditor[] = files.map((file) => ({
    relativePath: file.relativePath,
    language: file.language,
    ...(file.isPreview ? { isPreview: true } : {}),
    ...(file.readOnly ? { readOnly: true } : {})
  }))
  const activeFileId = session.activeFileIdByWorktree?.[key]
  return {
    tabs: (session.unifiedTabs?.[key] ?? []).map(
      ({ worktreeId: _worktreeId, executionHostId: _executionHostId, ...tab }) => tab
    ),
    groups: (session.tabGroups?.[key] ?? []).map(({ worktreeId: _worktreeId, ...group }) => group),
    groupLayout: session.tabGroupLayouts?.[key] ?? null,
    activeGroupId: session.activeGroupIdByWorktree?.[key] ?? null,
    terminalTabs,
    terminalLayouts: projectTerminalLayouts(
      session,
      terminalTabs.map((tab) => tab.id)
    ),
    startupCwdRelative,
    editors,
    activeEditorRelativePath:
      files.find((file) => file.filePath === activeFileId)?.relativePath ?? null,
    browsers: projectBrowsers(session, key),
    activeBrowserId: session.activeBrowserTabIdByWorktree?.[key] ?? null,
    activeTabType: session.activeTabTypeByWorktree?.[key] ?? null,
    activeTabId: session.activeTabIdByWorktree?.[key] ?? null
  }
}

function projectFocus(
  view: RecoveryLayout,
  isActiveWorkspace: boolean,
  windowFocused: boolean
): RecoveryPresentationFocus {
  const activeGroup = view.groups.find((group) => group.id === view.activeGroupId)
  const focusedTab = view.tabs.find((tab) => tab.id === activeGroup?.activeTabId)
  const focusedTabId = focusedTab?.id ?? view.activeTabId
  const terminalTabId = focusedTab
    ? focusedTab.contentType === 'terminal'
      ? focusedTab.entityId
      : null
    : view.activeTabId
  const focusedLeafId = terminalTabId
    ? (view.terminalLayouts[terminalTabId]?.activeLeafId ?? null)
    : null
  return {
    isActiveWorkspace,
    focusedTabId,
    focusedLeafId,
    focusedPaneKey: presentationPaneKey(terminalTabId, focusedLeafId),
    windowFocused
  }
}

// Why: sheds bulk a restore can live without before dropping a whole workspace.
function shrinkView(view: RecoveryLayout): RecoveryLayout {
  return {
    ...view,
    browsers: view.browsers.map((browser) => ({
      ...browser,
      pages: browser.pages.filter((page) => page.id === browser.activePageId)
    })),
    editors: view.editors.filter((editor) => editor.relativePath === view.activeEditorRelativePath)
  }
}

function recencyRank(candidate: Candidate, activeKey: string | null): [number, number, string] {
  const age = candidate.entry.input.msSinceHumanInput
  return [candidate.key === activeKey ? 0 : 1, age ?? Number.POSITIVE_INFINITY, candidate.key]
}

function compareCandidates(a: Candidate, b: Candidate, activeKey: string | null): number {
  const [aActive, aAge, aKey] = recencyRank(a, activeKey)
  const [bActive, bAge, bKey] = recencyRank(b, activeKey)
  if (aActive !== bActive) {
    return aActive - bActive
  }
  if (aAge !== bAge) {
    return aAge < bAge ? -1 : 1
  }
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

function capHostWorkspaces(ordered: Candidate[]): HostPresentationSnapshot {
  const workspaces: RecoveryPresentationWorkspace[] = []
  let truncated = false
  let totalBytes = PUBLISH_ENVELOPE_RESERVE_BYTES
  for (const candidate of ordered) {
    if (workspaces.length >= MAX_RECOVERY_PRESENTATION_WORKSPACES) {
      truncated = true
      break
    }
    let entry = candidate.entry
    if (jsonBytes(entry.view) > MAX_RECOVERY_PRESENTATION_WORKSPACE_VIEW_BYTES) {
      truncated = true
      entry = { ...entry, view: shrinkView(entry.view) }
      if (jsonBytes(entry.view) > MAX_RECOVERY_PRESENTATION_WORKSPACE_VIEW_BYTES) {
        continue
      }
    }
    const entryBytes = jsonBytes(entry) + 1
    if (totalBytes + entryBytes > MAX_RECOVERY_PRESENTATION_PUBLISH_BYTES) {
      truncated = true
      continue
    }
    totalBytes += entryBytes
    workspaces.push(entry)
  }
  return { workspaces, truncated }
}

/** Splits the client's session into per-host presentation publishes; SSH hosts publish nothing. */
export function projectCrossMachineRecoveryPresentation(
  input: PresentationProjectionInput
): Map<ExecutionHostId, HostPresentationSnapshot> {
  const activeKey = activePresentationSessionKey(input.session)
  const candidatesByHost = new Map<ExecutionHostId, Candidate[]>()
  for (const key of presentationSessionKeys(input.session)) {
    const hostId = sessionPartitionHostFor(input.hostIdByWorktreeId(key))
    if (parseExecutionHostId(hostId)?.kind === 'ssh') {
      continue
    }
    const view = projectPresentationView(input.session, key, input.catalog.pathFor(key))
    const isActiveWorkspace = key === activeKey
    const candidates = candidatesByHost.get(hostId) ?? []
    candidates.push({
      key,
      entry: {
        workspace: workspaceRef(key, input.catalog),
        view,
        focus: projectFocus(view, isActiveWorkspace, input.windowFocused),
        input: input.inputFor(key, activeKey)
      }
    })
    candidatesByHost.set(hostId, candidates)
  }
  const snapshots = new Map<ExecutionHostId, HostPresentationSnapshot>()
  for (const [hostId, candidates] of candidatesByHost) {
    candidates.sort((a, b) => compareCandidates(a, b, activeKey))
    snapshots.set(hostId, capHostWorkspaces(candidates))
  }
  return snapshots
}
