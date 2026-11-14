import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { provideLayoutFrameTerminalPanes } from '@/runtime/workspace-layout/frames/layout-frame-terminal-panes'
import { registerRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { createIpcPtySessionHandlers } from '../../pty-transport/ipc/ipc-pty-session-handlers'
import { createPtyOutputProcessor } from '../../pty-transport/output/pty-output-processor'

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

  it('interrupts a working session and restarts it at once, via the store subscription', async () => {
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      seedClaudePane({ state: 'working' })
      useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')

      await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({}))
    } finally {
      uninstall()
    }
  })

  it.each(['claude', 'codex'] as const)(
    'restarts a queued %s pane after mounted ownership and its handler are released',
    async (agent) => {
      seedClaudePane({ state: 'working' })
      const unregister = registerRuntimeTerminalTab({
        tabId: 'tab-1',
        worktreeId: 'wt1',
        getManager: () => null,
        getContainer: () => null,
        getPtyIdForPane: () => OLD_PTY,
        getTabWideAgentHintLeafId: () => LEAF_ID
      })
      const handlers = createIpcPtySessionHandlers({
        outputProcessor: createPtyOutputProcessor({}),
        getPtyId: () => OLD_PTY,
        getCallbacks: () => ({}),
        getSuppressAttentionEvents: () => false,
        markExited: () => {}
      })
      const uninstall = installCodexDetachedPaneRestartExecutor()
      try {
        useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], agent)
        await Promise.resolve()
        expect(window.api.pty.spawn).not.toHaveBeenCalled()
        // No transport bound before the queue; cleanup can also release an existing handler.
        handlers.registerData(OLD_PTY)
        unregister()
        expect(window.api.pty.spawn).not.toHaveBeenCalled()
        handlers.unregisterAll(OLD_PTY)
        await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledTimes(1))
        expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
        unregister()
        await Promise.resolve()
        expect(window.api.pty.spawn).toHaveBeenCalledTimes(1)
      } finally {
        unregister()
        handlers.unregisterAll(OLD_PTY)
        uninstall()
      }
    }
  )

  it.each([10, 100])(
    'bounds registry-burst work with %i pending restarts and ignores empty queues or uninstall',
    async (count) => {
      seedClaudePane({ state: 'working' })
      const tab = {
        tabId: 'tab-1',
        worktreeId: 'wt1',
        getManager: () => null,
        getContainer: () => null,
        getPtyIdForPane: () => OLD_PTY,
        getTabWideAgentHintLeafId: () => LEAF_ID
      }
      const unregister = registerRuntimeTerminalTab(tab)
      const uninstall = installCodexDetachedPaneRestartExecutor()
      await Promise.resolve()
      const microtasks = vi.spyOn(globalThis, 'queueMicrotask')
      try {
        for (let i = 0; i < count; i++) {
          registerRuntimeTerminalTab(tab)
        }
        expect(microtasks).not.toHaveBeenCalled()
        const pendingPtyIds = Array.from({ length: count }, (_, i) =>
          i === 0 ? OLD_PTY : `wt1@@unlocated-${i}`
        )
        useAppStore.getState().queuePaneAccountRestarts(pendingPtyIds, 'claude')
        await Promise.resolve()
        expect(Object.keys(useAppStore.getState().pendingPaneAccountRestarts)).toHaveLength(count)
        microtasks.mockClear()
        const enumerations = vi.spyOn(Object, 'keys')
        try {
          for (let i = 0; i < 10 * count; i++) {
            registerRuntimeTerminalTab(tab)
          }
          expect(enumerations).toHaveBeenCalledTimes(1)
        } finally {
          enumerations.mockRestore()
        }
        expect(microtasks).toHaveBeenCalledTimes(1)
        await Promise.resolve()
        expect(window.api.pty.spawn).not.toHaveBeenCalled()
        unregister()
        uninstall()
        await Promise.resolve()
        expect(window.api.pty.spawn).not.toHaveBeenCalled()
        microtasks.mockClear()
        const release = registerRuntimeTerminalTab(tab)
        release()
        expect(microtasks).not.toHaveBeenCalled()
      } finally {
        microtasks.mockRestore()
        uninstall()
        unregister()
      }
    }
  )
})
