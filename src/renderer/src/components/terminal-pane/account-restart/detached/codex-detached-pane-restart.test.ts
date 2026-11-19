import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeTerminalTab } from '@/store/terminals/testing/terminal-row.test-fixture'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import {
  resetDetachedCodexPaneRestartClaimsForTests,
  sweepUnclaimedCodexPaneRestarts
} from './codex-detached-pane-restart'

vi.mock(
  '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    hasRegisteredRuntimeTerminalTab: vi.fn(() => false)
  })
)
vi.mock('./detached-pane-restart-pty-release', () => ({
  killReplacedCodexPanePty: vi.fn(),
  reapUnboundCodexPty: vi.fn(),
  releaseReplacedCodexPanePty: vi.fn()
}))

const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const PTY_ID = 'pty-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const initialState = useAppStore.getState()
const spawn = vi.fn()
const queueTabStartupCommand = vi.fn()

function seedDetachedPane({ leafId }: { leafId: string | null }): void {
  useAppStore.setState({
    settings: getDefaultSettings('/home/dev'),
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId: PTY_ID })]
    },
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] },
    terminalLayoutsByTabId: leafId
      ? {
          [TAB_ID]: {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: PTY_ID }
          }
        }
      : {},
    queueTabStartupCommand
  })
}

beforeEach(() => {
  vi.stubGlobal('window', { api: { pty: { spawn } } })
})

afterEach(() => {
  resetDetachedCodexPaneRestartClaimsForTests()
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('does nothing for a manual restart of a leafless detached pane', async () => {
  seedDetachedPane({ leafId: null })
  useAppStore.getState().queuePaneManualRestarts([{ ptyId: PTY_ID, agent: 'gemini' }])

  await sweepUnclaimedCodexPaneRestarts()

  expect(spawn).not.toHaveBeenCalled()
  expect(queueTabStartupCommand).not.toHaveBeenCalled()
  expect(useAppStore.getState().pendingPaneManualRestarts).toEqual({})
})

it('requeues a manual restart into the manual queue when the tab mounts mid-claim', async () => {
  seedDetachedPane({ leafId: LEAF_ID })
  const paneKey = makePaneKey(TAB_ID, LEAF_ID)
  useAppStore.setState({
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        paneKey,
        {
          paneKey,
          tabId: TAB_ID,
          agentType: 'codex',
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: '01a006a6-1d07-70a1-bad5-f9110d5845c0' }
        }
      ]
    ])
  })
  // The tab registers after the claim check but before the spawn.
  vi.mocked(hasRegisteredRuntimeTerminalTab).mockReturnValueOnce(false).mockReturnValueOnce(true)
  useAppStore.getState().queuePaneManualRestarts([{ ptyId: PTY_ID, agent: 'codex' }])

  await sweepUnclaimedCodexPaneRestarts()

  // Both the claim check and the requeue check ran, so the entry really left the queue and came back.
  expect(hasRegisteredRuntimeTerminalTab).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().pendingPaneManualRestarts).toEqual({ [PTY_ID]: 'codex' })
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  expect(spawn).not.toHaveBeenCalled()
})
