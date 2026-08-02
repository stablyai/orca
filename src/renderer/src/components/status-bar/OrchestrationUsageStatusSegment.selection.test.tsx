// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

const mocks = vi.hoisted(() => ({
  now: 2_000_000_000,
  state: {} as Record<string, unknown>,
  useReport: vi.fn(() => ({
    report: null,
    error: null,
    stale: false,
    refreshing: false
  }))
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ instanceId: 'instance-1' })
}))

vi.mock('./use-orchestration-cost-report', () => ({
  useOrchestrationCostReport: mocks.useReport
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { OrchestrationUsageStatusSegment } from './OrchestrationUsageStatusSegment'

beforeEach(() => {
  mocks.now = 2_000_000_000
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mocks.useReport.mockClear()
})

describe('OrchestrationUsageStatusSegment selection invalidation', () => {
  it('reselects when agentStatusEpoch advances across the stale boundary', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
    mocks.state = {
      activeWorkspaceKey: 'worktree:wt-1',
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: 'local',
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [PANE]: {
          state: 'working',
          prompt: '',
          updatedAt: mocks.now - AGENT_STATUS_STALE_AFTER_MS,
          stateStartedAt: mocks.now - AGENT_STATUS_STALE_AFTER_MS,
          paneKey: PANE,
          worktreeId: 'wt-1',
          connectionId: null,
          stateHistory: [],
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'dispatch-1',
            orchestrationRunId: 'run-live'
          }
        }
      },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-local-1' } }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-local-1'] },
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    }

    const view = render(
      <TooltipProvider>
        <OrchestrationUsageStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    expect(mocks.useReport).toHaveBeenLastCalledWith({ kind: 'local' }, 'run-live', false)

    mocks.now += 1
    mocks.state = { ...mocks.state, agentStatusEpoch: 2 }
    view.rerender(
      <TooltipProvider>
        <OrchestrationUsageStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    expect(mocks.useReport).toHaveBeenLastCalledWith({ kind: 'local' }, null, false)
  })

  it('selects a runtime row from its exact environment-scoped live PTY binding', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
    const runtimePtyId = toRemoteRuntimePtyId('term-runtime', 'env-1')
    mocks.state = {
      activeWorkspaceKey: 'worktree:wt-1',
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: 'runtime:env-1',
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [PANE]: {
          state: 'working',
          prompt: '',
          updatedAt: mocks.now,
          stateStartedAt: mocks.now,
          paneKey: PANE,
          worktreeId: 'wt-1',
          connectionId: null,
          stateHistory: [],
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'dispatch-1',
            orchestrationRunId: 'run-runtime'
          }
        }
      },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF]: runtimePtyId } }
      },
      ptyIdsByTabId: { 'tab-1': [runtimePtyId] },
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:env-1' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'runtime:env-1',
            runtimeOwnerEnvironmentId: 'env-1'
          }
        ]
      },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    }

    render(
      <TooltipProvider>
        <OrchestrationUsageStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )

    expect(mocks.useReport).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'run-runtime',
      false
    )
  })
})
