// @vitest-environment happy-dom

import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import * as eventBuilder from '../events/activity-event-builder'
import { useAllAgentPaneThreads } from './use-agent-pane-threads'
import AgentListVerdictPublisher, {
  readPublishedAgentPaneThreads
} from '../paired-clients/agent-list-verdict-publisher'
import { whenAgentTerminalAppears } from '@/components/terminal-pane/provider-notices/agent-presence/agent-terminal-presence'
import { useWorkspaceSpaceDecisionProjection } from '@/components/status-bar/workspace-storage/decisions/use-workspace-space-decision-projection'
import { useWorkspaceSpaceManagerBindings } from '@/components/status-bar/workspace-storage/manager/use-workspace-space-manager-bindings'
import { getProjectRuntimeSessionSummary } from '@/components/settings/repository/runtime/repository-runtime-session-summary'
import {
  AcceptedAgentStatuses,
  acceptedAgentStatuses
} from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { resetAgentStatusEpochClockForTests } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { useWorktreeAgentRow } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSpaceWorktree } from '../../../../../shared/workspace-disk-space/workspace-space-types'

// Perf contract: React reads an external store's snapshot on every store write. When that read built the
// Activity events, a burst of writes in one task (status commit, generated title, tab titles; startup
// restore; a phone's bulk clear) built once per write instead of once per render.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetAgentStatusEpochClockForTests()
})

function buildsForWriteBurst(writes: number): number {
  const builds = vi.spyOn(eventBuilder, 'buildActivityEvents')
  renderHook(() => useAllAgentPaneThreads())
  builds.mockClear()
  act(() => {
    for (let index = 0; index < writes; index++) {
      useAppStore.setState({ acknowledgedAgentsByPaneKey: { [`tab-${index}:leaf`]: index } })
    }
  })
  const count = builds.mock.calls.length
  cleanup()
  builds.mockRestore()
  return count
}

it('a burst of Activity input writes in one task builds once, at N and 10N writes', () => {
  expect(buildsForWriteBurst(10)).toBe(1)
  expect(buildsForWriteBurst(100)).toBe(1)
})

it.each([100, 1000])(
  'does no unrelated row work for model updates with %s panes',
  async (count) => {
    const now = 1_000_000 + count * 10_000
    vi.useFakeTimers({ now, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const publishListVerdicts = vi.fn()
    vi.stubGlobal('api', {
      ...window.api,
      agentStatus: { ...window.api?.agentStatus, publishListVerdicts }
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    const path = '/tmp/activity-model'
    const worktreeId = `${TEST_REPO.id}::${path}`
    const tabs = Array.from({ length: count }, (_, index) =>
      makeTab({ id: `tab-${index}`, worktreeId, title: 'Terminal' })
    )
    const paneKeys = tabs.map(({ id }) => makePaneKey(id, leafId))
    const storageRow: WorkspaceSpaceWorktree = {
      worktreeId,
      repoId: TEST_REPO.id,
      repoDisplayName: TEST_REPO.displayName,
      repoPath: TEST_REPO.path,
      path,
      displayName: 'Activity model',
      branch: 'main',
      isMainWorktree: false,
      isRemote: false,
      isSparse: false,
      canDelete: true,
      lastActivityAt: now,
      status: 'ok',
      error: null,
      scannedAt: now,
      sizeBytes: 100,
      reclaimableBytes: 100,
      skippedEntryCount: 0,
      topLevelItems: [],
      omittedTopLevelItemCount: 0,
      omittedTopLevelSizeBytes: 0
    }
    useAppStore.setState({
      persistedUIReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: worktreeId, repoId: TEST_REPO.id, path })]
      },
      tabsByWorktree: { [worktreeId]: tabs },
      workspaceSpaceAnalysis: {
        scannedAt: now,
        totalSizeBytes: 100,
        reclaimableBytes: 100,
        worktreeCount: 1,
        scannedWorktreeCount: 1,
        unavailableWorktreeCount: 0,
        repos: [],
        worktrees: [storageRow]
      },
      agentStatusByPaneKey: acceptedAgentStatuses(
        tabs.map((tab, index) => [
          paneKeys[index]!,
          {
            paneKey: paneKeys[index]!,
            tabId: tab.id,
            worktreeId,
            connectionId: null,
            agentType: 'antigravity',
            prompt: 'Task',
            state: 'working',
            updatedAt: now,
            evidenceObservedAt: now,
            stateStartedAt: now,
            stateObservedAt: now,
            firstStateStartedAt: now,
            turnStartedAt: now,
            terminalTitle: 'Terminal',
            stateHistory: [],
            providerSession: { key: 'conversation_id', id: `session-${index}` }
          }
        ])
      )
    })
    const appeared = vi.fn()
    const stopNotice = whenAgentTerminalAppears('codex', appeared)
    const renderSummary = () =>
      getProjectRuntimeSessionSummary(useAppStore.getState(), TEST_REPO.id)
    let summary = renderSummary()
    const stopSummary = useAppStore.subscribe(() => {
      summary = renderSummary()
    })
    try {
      render(<AgentListVerdictPublisher />)
      const paneKey = paneKeys[0]!
      const sidebarRow = renderHook(() => useWorktreeAgentRow(paneKey))
      const decisions = renderHook(() =>
        useWorkspaceSpaceDecisionProjection(useWorkspaceSpaceManagerBindings())
      )
      const readDetails = () => decisions.result.current.decisionDetailsByWorktreeId
      const activeAgents = () => readDetails().values().next().value?.activeAgentCount
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(activeAgents()).toBe(count)
      expect(summary.activeTaskCount).toBe(count)
      expect(publishListVerdicts).toHaveBeenCalledTimes(1)
      const priorThreads = readPublishedAgentPaneThreads()
      const priorDetails = readDetails()
      const builds = vi.spyOn(eventBuilder, 'buildActivityEvents')
      const entries = vi.spyOn(AcceptedAgentStatuses.prototype, 'entries')
      const keys = vi.spyOn(AcceptedAgentStatuses.prototype, 'keys')
      const apply = (next: Parameters<AcceptedAgentStatuses['replace']>[0]) =>
        useAppStore.setState((state) => ({
          agentStatusByPaneKey: state.agentStatusByPaneKey.replace(next)
        }))
      const row = useAppStore.getState().agentStatusByPaneKey.get(paneKey)!
      act(() => apply([[paneKey, { ...row, model: 'resolved-model', acceptedStatusSeq: 2 }]]))
      expect(sidebarRow.result.current?.entry.model).toBe('resolved-model')
      expect(readPublishedAgentPaneThreads()).toBe(priorThreads)
      expect(readDetails()).toBe(priorDetails)
      expect(builds).not.toHaveBeenCalled()
      expect(entries).not.toHaveBeenCalled()
      expect(keys).not.toHaveBeenCalled()
      expect(appeared).not.toHaveBeenCalled()

      entries.mockRestore()
      keys.mockRestore()
      act(() => apply([[paneKey, { ...row, evidenceObservedAt: now - 1_800_001 }]]))
      expect(activeAgents()).toBe(count - 1)
      expect(summary.activeTaskCount).toBe(count)
      expect(appeared).not.toHaveBeenCalled()
      act(() => apply([[paneKey, { ...row, state: 'done', agentType: 'codex' }]]))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(appeared).toHaveBeenCalledTimes(1)
      expect(summary.activeTaskCount).toBe(count - 1)
      expect(activeAgents()).toBe(count - 1)
      expect(readPublishedAgentPaneThreads()).not.toBe(priorThreads)
      expect(publishListVerdicts).toHaveBeenCalledTimes(2)
    } finally {
      stopNotice()
      stopSummary()
      cleanup()
    }
  }
)
