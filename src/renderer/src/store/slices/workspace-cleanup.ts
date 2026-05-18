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
  canQueueWorkspaceCleanupCandidate,
  canSelectWorkspaceCleanupCandidate,
  shouldForceWorkspaceCleanupRemoval,
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

type WorkspaceCleanupViewedCandidate = {
  viewedAt: number
  fingerprint: string
  wasSuggested: boolean
}

export type WorkspaceCleanupSlice = {
  workspaceCleanupScan: WorkspaceCleanupScanResult | null
  workspaceCleanupLoading: boolean
  workspaceCleanupError: string | null
  workspaceCleanupDismissals: Record<string, WorkspaceCleanupDismissal>
  workspaceCleanupViewedCandidates: Record<string, WorkspaceCleanupViewedCandidate>
  scanWorkspaceCleanup: (args?: WorkspaceCleanupScanArgs) => Promise<WorkspaceCleanupScanResult>
  markWorkspaceCleanupCandidateViewed: (candidate: WorkspaceCleanupCandidate) => void
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
const VIEWED_FROM_CLEANUP_MS = 2 * 60 * 60 * 1000

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
  workspaceCleanupViewedCandidates: {},

  scanWorkspaceCleanup: async (args) => {
    set({ workspaceCleanupLoading: true, workspaceCleanupError: null })
    try {
      const scanArgs =
        args?.worktreeId !== undefined
          ? args
          : {
              ...args,
              skipGitWorktreeIds: [
                ...new Set([
                  ...(args?.skipGitWorktreeIds ?? []),
                  ...getInitialWorkspaceCleanupGitDeferrals(get())
                ])
              ]
            }
      const scan = await window.api.workspaceCleanup.scan(scanArgs)
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

  markWorkspaceCleanupCandidateViewed: (candidate) => {
    set((state) => ({
      workspaceCleanupViewedCandidates: {
        ...state.workspaceCleanupViewedCandidates,
        [candidate.worktreeId]: {
          viewedAt: Date.now(),
          fingerprint: candidate.fingerprint,
          wasSuggested: candidate.tier === 'ready' && canSelectWorkspaceCleanupCandidate(candidate)
        }
      }
    }))
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
      const preflight = await preflightWorkspaceCleanupCandidate(worktreeId, get)
      if (!preflight.ok) {
        failures.push(preflight.failure)
        continue
      }

      const result = await get().removeWorktree(
        worktreeId,
        shouldForceWorkspaceCleanupRemoval(preflight.candidate)
      )
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

function getInitialWorkspaceCleanupGitDeferrals(state: AppState): string[] {
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
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tabIds = new Set(tabs.map((tab) => tab.id))
    if (tabs.some((tab) => (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0)) {
      ids.add(worktreeId)
    }
    if (hasFreshLiveAgent(state, tabIds) || hasWorkingTitleAgent(state, tabs)) {
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
    const lastVisitedAt = state.lastVisitedAtByWorktreeId[worktreeId] ?? 0
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
  const preserveCleanupInspection = shouldPreserveCleanupInspection(candidate, state)

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

  const terminalProbe = await probeTerminalLiveness(state, tabs)
  if (terminalProbe === 'running') {
    blockers.push('running-terminal')
  } else if (terminalProbe === 'unknown') {
    blockers.push('terminal-liveness-unknown')
  }

  const lastVisitedAt = state.lastVisitedAtByWorktreeId[candidate.worktreeId] ?? 0
  const hasVisibleContext = cleanEditorTabCount > 0 || browserTabCount > 0
  if (
    hasVisibleContext &&
    !preserveCleanupInspection &&
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

function shouldPreserveCleanupInspection(
  candidate: WorkspaceCleanupCandidate,
  state: AppState
): boolean {
  const viewed = state.workspaceCleanupViewedCandidates[candidate.worktreeId]
  if (!viewed?.wasSuggested || viewed.fingerprint !== candidate.fingerprint) {
    return false
  }
  // Why: View is part of cleanup review. It should not make the same
  // suggested row vanish on the next scan, but this exception must expire.
  return Date.now() - viewed.viewedAt <= VIEWED_FROM_CLEANUP_MS
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
  getState: () => AppState
): Promise<
  | { ok: true; candidate: WorkspaceCleanupCandidate }
  | { ok: false; failure: WorkspaceCleanupFailure }
> {
  const scan = await window.api.workspaceCleanup.scan({ worktreeId })
  const [candidate] = await enrichWorkspaceCleanupCandidates(scan.candidates, getState(), {
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
  if (!canQueueWorkspaceCleanupCandidate(candidate)) {
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
  return detectAgentStatusFromTitle(title) === 'idle'
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
