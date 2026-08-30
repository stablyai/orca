import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { classifyTitleActivity, isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-process-inspection'
import {
  hasPublishedPtyProcessInspectionEvidence,
  readPtyProcessInspectionEvidence
} from '../../../../shared/pty-process-inspection-evidence'

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
  const agentStatusesByTabId = buildWorkspaceCleanupAgentStatusIndex(state)
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tabIds = new Set(tabs.map((tab) => tab.id))
    if (tabs.some((tab) => (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0)) {
      ids.add(worktreeId)
    }
    if (
      hasFreshIndexedLiveAgent(agentStatusesByTabId, tabIds) ||
      hasWorkingTitleAgent(state, tabs)
    ) {
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

export function buildWorkspaceCleanupAgentStatusIndex(
  state: AppState,
  includedTabIds?: ReadonlySet<string>
): Map<string, AgentStatusEntry[]> {
  const agentStatusesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    const tabId = getPaneKeyTabId(entry.paneKey)
    if (includedTabIds && !includedTabIds.has(tabId)) {
      continue
    }
    const entries = agentStatusesByTabId.get(tabId) ?? []
    entries.push(entry)
    agentStatusesByTabId.set(tabId, entries)
  }
  return agentStatusesByTabId
}

export function hasFreshIndexedLiveAgent(
  agentStatusesByTabId: ReadonlyMap<string, readonly AgentStatusEntry[]>,
  tabIds: Set<string>
): boolean {
  const now = Date.now()
  for (const tabId of tabIds) {
    for (const entry of agentStatusesByTabId.get(tabId) ?? []) {
      if (
        isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) &&
        (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
      ) {
        return true
      }
    }
  }
  return false
}

export function hasWorkingTitleAgent(
  state: AppState,
  tabs: { id: string; title: string }[]
): boolean {
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
): Promise<'idle' | 'running' | 'unverifiable'> {
  const ptyChecks = tabs.flatMap((tab) =>
    (state.ptyIdsByTabId[tab.id] ?? []).map((ptyId) => ({ tab, ptyId }))
  )
  if (ptyChecks.length === 0) {
    return 'idle'
  }

  let unverifiable = false
  for (const { tab, ptyId } of ptyChecks) {
    try {
      // Why: the standalone hasChildProcesses/getForegroundProcess handlers coerce a
      // degraded read to false/null below IPC, so an unreachable host arrived here as
      // an idle shell and cleanup dropped its blocker. inspectProcess is the only read
      // that carries `unavailable` across the boundary; loss of contact is never idle.
      const inspection = await inspectRuntimeTerminalProcess(state.settings, ptyId)
      if (inspection.unavailable === true) {
        unverifiable = true
        continue
      }
      // Why the evidence and not the legacy fields: `unavailable` only covers a
      // handle we could not route to. A host that DID answer but whose probes
      // failed publishes the legacy collapse (null/false, or the shell name from
      // the stable cache) — byte-identical to an idle shell. Only processEvidence
      // separates "observed idle" from "could not ask", and this is a delete path.
      const evidence = readPtyProcessInspectionEvidence(inspection)
      if (
        evidence.foreground.verdict === 'unverifiable' ||
        evidence.children.verdict === 'unverifiable'
      ) {
        unverifiable = true
        continue
      }
      // Why: a host that published no evidence at all was read back through the
      // reader's LEGACY fallback, which restates its two values as an observation.
      // A retained pre-v27 daemon publishes `zsh` + `false` both when the pane
      // really sits at an idle shell and when its foreground read fell back to the
      // shell title, and it has no field to tell the two apart. Believe such a host
      // when it reports live work — that can only add a blocker — but never let its
      // silence stand as proof of idle on the path that deletes the workspace.
      if (
        !hasPublishedPtyProcessInspectionEvidence(inspection) &&
        evidence.children.verdict !== 'live'
      ) {
        unverifiable = true
        continue
      }
      const processName = normalizeProcessName(evidence.foreground.processName)
      if (
        evidence.children.verdict !== 'live' &&
        (!processName || SHELL_PROCESS_NAMES.has(processName))
      ) {
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
      unverifiable = true
    }
  }

  return unverifiable ? 'unverifiable' : 'idle'
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

function getPaneKeyTabId(paneKey: AgentStatusEntry['paneKey']): string {
  const separatorIndex = paneKey.lastIndexOf(':')
  return separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
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
