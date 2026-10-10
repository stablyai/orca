import type { AppState } from '../types'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'

const RECENT_VISIBLE_CONTEXT_MS = 24 * 60 * 60 * 1000
const VIEWED_FROM_CLEANUP_MS = 2 * 60 * 60 * 1000
const SHELL_PROCESS_NAMES = new Set([
  'bash',
  'cmd',
  'fish',
  'nu',
  'powershell',
  'pwsh',
  'sh',
  'zsh'
])
const AGENT_PROCESS_NAMES = new Set([
  'aider',
  'amp',
  'agy',
  'claude',
  'claude-code',
  'codex',
  'crush',
  'droid',
  'gemini',
  'gemini-cli',
  'goose',
  'opencode'
])

export function shouldPreserveCleanupInspection(
  candidate: WorkspaceCleanupCandidate,
  state: AppState
): boolean {
  const viewed = state.workspaceCleanupViewedCandidates[candidate.worktreeId]
  if (!viewed || viewed.fingerprint !== candidate.fingerprint) {
    return false
  }
  return Date.now() - viewed.viewedAt <= VIEWED_FROM_CLEANUP_MS
}

export function getInitialWorkspaceCleanupGitDeferrals(state: AppState): string[] {
  const ids = new Set<string>()
  if (state.activeWorktreeId) {
    ids.add(state.activeWorktreeId)
  }

  for (const file of state.openFiles) {
    if (file.isDirty || state.editorDrafts[file.id] !== undefined) {
      ids.add(file.worktreeId)
    }
  }

  const openEditorWorktreeIds = new Set(state.openFiles.map((file) => file.worktreeId))
  // A working-title agent needs a live PTY, so the PTY check below already covers it.
  for (const worktreeId of getWorkspaceCleanupLiveAgentSessionWorktreeIds(state)) {
    ids.add(worktreeId)
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0)) {
      ids.add(worktreeId)
    }
  }

  for (const worktreeId of new Set([
    ...openEditorWorktreeIds,
    ...Object.keys(state.browserTabsByWorktree)
  ])) {
    const hasVisibleContext =
      openEditorWorktreeIds.has(worktreeId) ||
      (state.browserTabsByWorktree[worktreeId]?.length ?? 0) > 0
    // Why: enrichment state may be a plain snapshot without slice methods.
    const lastVisitedAt =
      getWorktreeVisitTimestamp(state.lastVisitedAtByWorktreeId, {
        id: worktreeId,
        hostId: state.getKnownWorktreeById?.(worktreeId)?.hostId
      }) ?? 0
    if (
      hasVisibleContext &&
      lastVisitedAt > 0 &&
      Date.now() - lastVisitedAt <= RECENT_VISIBLE_CONTEXT_MS
    ) {
      ids.add(worktreeId)
    }
  }

  // Why: these rows must stay visible, but they already need user attention.
  // Defer expensive git reads until a focused refresh/remove preflight.
  return [...ids]
}

/** Workspaces with a live agent session, attributed like the sidebar so structured chats count too. */
export function getWorkspaceCleanupLiveAgentSessionWorktreeIds(state: AppState): Set<string> {
  return getWorktreeIdsWithLiveAgent(state.agentStatusByPaneKey, state.tabsByWorktree, Date.now())
}

/** The scan's live-agent test: a live agent session, or a terminal whose title says an agent is working. */
export function hasWorkspaceCleanupLiveAgent(
  state: AppState,
  worktreeId: string,
  liveAgentSessionWorktreeIds: ReadonlySet<string>
): boolean {
  return (
    liveAgentSessionWorktreeIds.has(worktreeId) ||
    hasWorkingTitleAgent(state, state.tabsByWorktree[worktreeId] ?? [])
  )
}

export function findWorkspaceCleanupLiveAgentWorktreeIds(
  state: AppState,
  worktreeIds: Iterable<string>
): Set<string> {
  const liveAgentSessionWorktreeIds = getWorkspaceCleanupLiveAgentSessionWorktreeIds(state)
  const liveWorktreeIds = new Set<string>()
  for (const worktreeId of worktreeIds) {
    if (hasWorkspaceCleanupLiveAgent(state, worktreeId, liveAgentSessionWorktreeIds)) {
      liveWorktreeIds.add(worktreeId)
    }
  }
  return liveWorktreeIds
}

function hasWorkingTitleAgent(state: AppState, tabs: { id: string; title: string }[]): boolean {
  for (const tab of tabs) {
    if ((state.ptyIdsByTabId[tab.id]?.length ?? 0) === 0) {
      continue
    }
    const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
    const titles =
      paneTitles && Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
    for (const title of titles) {
      const status = classifyTitleActivity(title)
      if (status === 'working' || status === 'permission') {
        return true
      }
    }
  }
  return false
}

export async function probeTerminalLiveness(
  state: AppState,
  tabs: { id: string; title: string }[]
): Promise<'idle' | 'running' | 'unknown'> {
  const ptyChecks = tabs.flatMap((tab) =>
    (state.ptyIdsByTabId[tab.id] ?? []).map((ptyId) => ({ tab, ptyId }))
  )
  if (ptyChecks.length === 0) {
    return 'idle'
  }

  let unknown = false
  for (const { tab, ptyId } of ptyChecks) {
    try {
      const [hasChildProcesses, foregroundProcess] = await Promise.all([
        window.api.pty.hasChildProcesses(ptyId),
        window.api.pty.getForegroundProcess(ptyId)
      ])
      const processName = normalizeProcessName(foregroundProcess)
      if (!hasChildProcesses && (!processName || SHELL_PROCESS_NAMES.has(processName))) {
        continue
      }
      if (
        processName &&
        AGENT_PROCESS_NAMES.has(processName) &&
        hasIdleAgentTitleForPty(state, tab, ptyId)
      ) {
        continue
      }
      return 'running'
    } catch {
      unknown = true
    }
  }

  return unknown ? 'unknown' : 'idle'
}

function hasIdleAgentTitleForPty(
  state: AppState,
  tab: { id: string; title: string },
  ptyId: string
): boolean {
  const paneTitles = state.runtimePaneTitlesByTabId[tab.id] ?? {}
  const layoutPtyIds = state.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
  const matchingTitles = Object.entries(layoutPtyIds)
    .filter(([, leafPtyId]) => leafPtyId === ptyId)
    .map(([leafId]) => paneTitles[leafId.replace(/^pane:/, '')])
    .filter((title): title is string => typeof title === 'string')

  if (matchingTitles.length > 0) {
    return matchingTitles.some(isIdleAgentTitle)
  }

  // Why: without a pane->PTY binding, a tab-level idle title is safe evidence
  // only when this tab has a single live PTY. Multi-pane tabs stay protected.
  const tabPtyIds = state.ptyIdsByTabId[tab.id] ?? []
  if (tabPtyIds.length !== 1) {
    return false
  }

  const titles = Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
  return titles.some(isIdleAgentTitle)
}

function isIdleAgentTitle(title: string): boolean {
  return classifyTitleActivity(title) === 'idle'
}

function normalizeProcessName(value: string | null): string | null {
  if (!value) {
    return null
  }
  const normalizedPath = value.replace(/\\/g, '/')
  const name = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1).toLowerCase()
  // Why: Windows reports `claude.exe`/`cmd.exe`; the name sets hold bare names.
  return name.replace(/\.exe$/, '')
}
