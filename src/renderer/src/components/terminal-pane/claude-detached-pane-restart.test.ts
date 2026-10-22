import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { sweepUnclaimedCodexPaneRestarts } from './codex-detached-pane-restart'
import {
  installCodexDetachedPaneRestartExecutor,
  resetCodexDetachedPaneRestartExecutorForTests
} from './codex-detached-pane-restart-scheduler'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'

function seedClaudePane(
  overrides: Partial<Pick<AgentStatusEntry, 'state' | 'providerSession'>> = {}
): void {
  const paneKey = makePaneKey('tab-1', LEAF_ID)
  useAppStore.setState({
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: OLD_PTY,
          worktreeId: 'wt1',
          title: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: OLD_PTY }
      }
    },
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        tabId: 'tab-1',
        state: 'done',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        agentType: 'claude',
        providerSession: { key: 'session_id', id: SESSION_ID },
        ...overrides
      }
    }
  })
}

function setPaneState(state: AgentStatusEntry['state']): void {
  const paneKey = makePaneKey('tab-1', LEAF_ID)
  const entry = useAppStore.getState().agentStatusByPaneKey[paneKey]
  useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: { ...entry, state } } })
}

/** Lets a queued sweep run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('detached Claude account-move restart', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    // Why: switch on, a restart binds only into a pane main's layout holds.
    provideLayoutFrameTerminalPanes({
      holdsTerminalPane: () => false,
      terminalTab: (worktreeId, tabId) =>
        worktreeId === 'wt1' && tabId === 'tab-1'
          ? {
              id: 'tab-1',
              kind: 'terminal',
              entityId: 'tab-1',
              executionHostId: 'local',
              createdAt: 1,
              customTitle: null,
              color: null,
              terminal: {
                root: { type: 'leaf', leafId: LEAF_ID },
                panes: [{ leafId: LEAF_ID, ptyId: OLD_PTY }]
              }
            }
          : undefined
    })
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: NEW_PTY }),
          kill: vi.fn().mockResolvedValue(undefined)
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('respawns an unmounted Claude pane with a resume of its own session', async () => {
    seedClaudePane()
    useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')

    await sweepUnclaimedCodexPaneRestarts()

    const spawnArgs = vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]
    expect(spawnArgs).toEqual(
      expect.objectContaining({
        launchAgent: 'claude',
        startupCommandDelivery: 'shell-ready',
        replacesPtyId: OLD_PTY,
        leafId: LEAF_ID
      })
    )
    expect(spawnArgs?.command).toMatch(new RegExp(`^claude .*'--resume' '${SESSION_ID}'$`))
    const state = useAppStore.getState()
    expect(state.pendingPaneAccountRestarts).toEqual({})
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: NEW_PTY })
  })

  it('restarts a mid-turn session once its turn ends, via the store subscription', async () => {
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      seedClaudePane({ state: 'working' })
      useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')
      await settle()
      // Why waiting: Claude's hooks report a permission prompt or question as waiting, mid-turn.
      setPaneState('waiting')
      await settle()
      expect(window.api.pty.spawn).not.toHaveBeenCalled()
      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ [OLD_PTY]: 'claude' })

      setPaneState('done')

      await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({}))
    } finally {
      uninstall()
    }
  })

  it('skips a pane whose session can no longer be resumed instead of starting a fresh Claude', async () => {
    seedClaudePane({ providerSession: undefined })
    useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')

    await sweepUnclaimedCodexPaneRestarts()

    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })
})
