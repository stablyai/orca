/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  applyWorkspaceCleanupPolicy,
  canSelectWorkspaceCleanupCandidate,
  shouldHideWorkspaceCleanupCandidate,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissal,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type WorkspaceCleanupFailure = {
  worktreeId: string
  displayName: string
  message: string
}

export type WorkspaceCleanupRemoveResult = {
  removedIds: string[]
  failures: WorkspaceCleanupFailure[]
}

export type WorkspaceCleanupSlice = {
  workspaceCleanupScan: WorkspaceCleanupScanResult | null
  workspaceCleanupLoading: boolean
  workspaceCleanupError: string | null
  workspaceCleanupDismissals: Record<string, WorkspaceCleanupDismissal>
  scanWorkspaceCleanup: (args?: WorkspaceCleanupScanArgs) => Promise<WorkspaceCleanupScanResult>
  dismissWorkspaceCleanupCandidates: (
    candidates: readonly WorkspaceCleanupCandidate[]
  ) => Promise<void>
  resetWorkspaceCleanupDismissals: () => Promise<void>
  removeWorkspaceCleanupCandidates: (
    worktreeIds: readonly string[]
  ) => Promise<WorkspaceCleanupRemoveResult>
}

type EnrichOptions = {
  applyDismissals?: boolean
}

const RECENT_VISIBLE_CONTEXT_MS = 24 * 60 * 60 * 1000

const SHELL_PROCESS_NAMES = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'fish',
  'nu',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'zsh'
])

const AGENT_PROCESS_NAMES = new Set([
  'aider',
  'amp',
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

export const createWorkspaceCleanupSlice: StateCreator<AppState, [], [], WorkspaceCleanupSlice> = (
  set,
  get
) => ({
  workspaceCleanupScan: null,
  workspaceCleanupLoading: false,
  workspaceCleanupError: null,
  workspaceCleanupDismissals: {},

  scanWorkspaceCleanup: async (args) => {
    set({ workspaceCleanupLoading: true, workspaceCleanupError: null })
    try {
      const scan = await window.api.workspaceCleanup.scan(args)
      const enriched = await enrichWorkspaceCleanupCandidates(scan.candidates, get())
      const result = { ...scan, candidates: enriched }
      set({ workspaceCleanupScan: result, workspaceCleanupLoading: false })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ workspaceCleanupError: message, workspaceCleanupLoading: false })
      throw error
    }
  },

  dismissWorkspaceCleanupCandidates: async (candidates) => {
    const now = Date.now()
    const dismissals = candidates.map((candidate) => ({
      worktreeId: candidate.worktreeId,
      dismissedAt: now,
      fingerprint: candidate.fingerprint,
      classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
    }))

    set((state) => {
      const nextDismissals = { ...state.workspaceCleanupDismissals }
      for (const dismissal of dismissals) {
        nextDismissals[dismissal.worktreeId] = dismissal
      }
      const nextScan = state.workspaceCleanupScan
        ? {
            ...state.workspaceCleanupScan,
            candidates: state.workspaceCleanupScan.candidates.map((candidate) =>
              applyDismissal(candidate, nextDismissals)
            )
          }
        : state.workspaceCleanupScan
      return {
        workspaceCleanupDismissals: nextDismissals,
        workspaceCleanupScan: nextScan
      }
    })

    await window.api.workspaceCleanup.dismiss({ dismissals })
  },

  resetWorkspaceCleanupDismissals: async () => {
    set((state) => ({
      workspaceCleanupDismissals: {},
      workspaceCleanupScan: state.workspaceCleanupScan
        ? {
            ...state.workspaceCleanupScan,
            candidates: state.workspaceCleanupScan.candidates.map((candidate) =>
              applyWorkspaceCleanupPolicy({
                ...candidate,
                blockers: candidate.blockers.filter((blocker) => blocker !== 'dismissed')
              })
            )
          }
        : state.workspaceCleanupScan
    }))
    await window.api.workspaceCleanup.clearDismissals()
  },

  removeWorkspaceCleanupCandidates: async (worktreeIds) => {
    const removedIds: string[] = []
    const failures: WorkspaceCleanupFailure[] = []

    for (const worktreeId of worktreeIds) {
      const preflight = await preflightWorkspaceCleanupCandidate(worktreeId, get())
      if (!preflight.ok) {
        failures.push(preflight.failure)
        continue
      }

      const result = await get().removeWorktree(worktreeId, false)
      if (result.ok) {
        removedIds.push(worktreeId)
      } else {
        failures.push({
          worktreeId,
          displayName: preflight.candidate.displayName,
          message: result.error
        })
      }
    }

    if (removedIds.length > 0) {
      set((state) => ({
        workspaceCleanupScan: state.workspaceCleanupScan
          ? {
              ...state.workspaceCleanupScan,
              candidates: state.workspaceCleanupScan.candidates.filter(
                (candidate) => !removedIds.includes(candidate.worktreeId)
              )
            }
          : state.workspaceCleanupScan
      }))
    }

    return { removedIds, failures }
  }
})

export async function enrichWorkspaceCleanupCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  options: EnrichOptions = {}
): Promise<WorkspaceCleanupCandidate[]> {
  return Promise.all(
    candidates.map((candidate) => enrichWorkspaceCleanupCandidate(candidate, state, options))
  )
}

async function enrichWorkspaceCleanupCandidate(
  candidate: WorkspaceCleanupCandidate,
  state: AppState,
  options: EnrichOptions
): Promise<WorkspaceCleanupCandidate> {
  const tabs = state.tabsByWorktree[candidate.worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const livePtyIds = tabs.flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
  const openFiles = state.openFiles.filter((file) => file.worktreeId === candidate.worktreeId)
  const dirtyEditorBuffers = openFiles.filter(
    (file) => file.isDirty || state.editorDrafts[file.id] !== undefined
  )
  const cleanEditorTabCount = openFiles.length - dirtyEditorBuffers.length
  const browserTabCount = (state.browserTabsByWorktree[candidate.worktreeId] ?? []).length
  const retainedDoneAgentCount = Object.values(state.retainedAgentsByPaneKey).filter(
    (entry) => entry.worktreeId === candidate.worktreeId && entry.entry.state === 'done'
  ).length
  const blockers = candidate.blockers.filter((blocker) => blocker !== 'dismissed')

  if (state.activeWorktreeId === candidate.worktreeId) {
    blockers.push('active-workspace')
  }
  if (dirtyEditorBuffers.length > 0) {
    blockers.push('dirty-editor-buffer')
  }
  if (hasFreshLiveAgent(state, tabIds)) {
    blockers.push('live-agent')
  }
  if (hasWorkingTitleAgent(state, tabs)) {
    blockers.push('live-agent')
  }

  const terminalProbe = await probeTerminalLiveness(candidate, state, tabs, livePtyIds)
  if (terminalProbe === 'running') {
    blockers.push('running-terminal')
  } else if (terminalProbe === 'unknown') {
    blockers.push('terminal-liveness-unknown')
  }

  const lastVisitedAt = state.lastVisitedAtByWorktreeId[candidate.worktreeId] ?? 0
  const hasVisibleContext = cleanEditorTabCount > 0 || browserTabCount > 0
  const hasStrongCompletion = hasStrongCompletionEvidence(candidate)
  if (
    hasVisibleContext &&
    !hasStrongCompletion &&
    lastVisitedAt > 0 &&
    Date.now() - lastVisitedAt <= RECENT_VISIBLE_CONTEXT_MS
  ) {
    blockers.push('recent-visible-context')
  }

  const enriched = applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: [...new Set(blockers)],
    localContext: {
      ...candidate.localContext,
      terminalTabCount: tabs.length,
      cleanEditorTabCount,
      browserTabCount,
      retainedDoneAgentCount
    }
  })

  return options.applyDismissals === false
    ? enriched
    : applyDismissal(enriched, state.workspaceCleanupDismissals)
}

function applyDismissal(
  candidate: WorkspaceCleanupCandidate,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): WorkspaceCleanupCandidate {
  if (!shouldHideWorkspaceCleanupCandidate(candidate, dismissals[candidate.worktreeId])) {
    return candidate
  }
  return applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: [...new Set<WorkspaceCleanupBlocker>([...candidate.blockers, 'dismissed'])]
  })
}

async function preflightWorkspaceCleanupCandidate(
  worktreeId: string,
  state: AppState
): Promise<
  | { ok: true; candidate: WorkspaceCleanupCandidate }
  | { ok: false; failure: WorkspaceCleanupFailure }
> {
  const scan = await window.api.workspaceCleanup.scan({ worktreeId })
  const [candidate] = await enrichWorkspaceCleanupCandidates(scan.candidates, state, {
    applyDismissals: false
  })
  if (!candidate) {
    return {
      ok: false,
      failure: {
        worktreeId,
        displayName: worktreeId,
        message: 'Workspace no longer exists.'
      }
    }
  }
  if (!canSelectWorkspaceCleanupCandidate(candidate)) {
    return {
      ok: false,
      failure: {
        worktreeId,
        displayName: candidate.displayName,
        message: candidate.blockers.length
          ? candidate.blockers.join(', ')
          : 'Workspace is no longer safe to remove.'
      }
    }
  }
  return { ok: true, candidate }
}

function hasFreshLiveAgent(state: AppState, tabIds: Set<string>): boolean {
  const now = Date.now()
  return Object.values(state.agentStatusByPaneKey).some(
    (entry) =>
      tabIds.has(getPaneKeyTabId(entry.paneKey)) &&
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) &&
      (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
  )
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
      const status = detectAgentStatusFromTitle(title)
      if (status === 'working' || status === 'permission') {
        return true
      }
    }
  }
  return false
}

async function probeTerminalLiveness(
  candidate: WorkspaceCleanupCandidate,
  state: AppState,
  tabs: { id: string; title: string }[],
  livePtyIds: string[]
): Promise<'idle' | 'running' | 'unknown'> {
  if (livePtyIds.length === 0) {
    return 'idle'
  }

  let unknown = false
  for (const ptyId of livePtyIds) {
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
        (hasStrongCompletionEvidence(candidate) || hasIdleAgentTitle(state, tabs))
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

function hasIdleAgentTitle(state: AppState, tabs: { id: string; title: string }[]): boolean {
  for (const tab of tabs) {
    const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
    const titles =
      paneTitles && Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
    for (const title of titles) {
      const status = detectAgentStatusFromTitle(title)
      if (status === 'idle') {
        return true
      }
    }
  }
  return false
}

function hasStrongCompletionEvidence(candidate: WorkspaceCleanupCandidate): boolean {
  return (
    candidate.reasons.includes('pr-merged') ||
    candidate.reasons.includes('pr-closed-clean') ||
    candidate.git.branchCompareChangedFiles === 0
  )
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
  return name.replace(/\.exe$/i, '.exe')
}
