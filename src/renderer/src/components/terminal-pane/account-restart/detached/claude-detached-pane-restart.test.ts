import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { provideLayoutFrameTerminalPanes } from '@/runtime/workspace-layout/frames/layout-frame-terminal-panes'
import { registerRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import { createIpcPtySessionHandlers } from '../../pty-transport/ipc/ipc-pty-session-handlers'
import { createPtyOutputProcessor } from '../../pty-transport/output/pty-output-processor'

import {
  installCodexDetachedPaneRestartExecutor,
  resetCodexDetachedPaneRestartExecutorForTests
} from './codex-detached-pane-restart-scheduler'
import {
  recordQueuedClaudeRestarts,
  takeQueuedClaudeRestart
} from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
import { ptyDataHandlers } from '../../pty-transport/shutdown/pty-shutdown-data-suspension'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'
const SESSION_ID = '00000000-0000-4000-8000-0000000000a1'

function seedClaudePane(
  overrides: Partial<Pick<AgentStatusEntry, 'state' | 'providerSession' | 'agentType'>> = {}
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
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
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
      })
    )
  })
}

function setRunningSessionSetting(value: ClaudeAccountSwitchRunningSessions): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/dev'), claudeAccountSwitchRunningSessions: value }
  })
}

function queueFromSwitch(): void {
  const setting = useAppStore.getState().settings?.claudeAccountSwitchRunningSessions
  recordQueuedClaudeRestarts([OLD_PTY], setting === 'restart-all')
  useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')
}

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

  it.each(['ask', 'restart', 'keep'] as const)(
    'under %s, a rejected spawn is tried once and its restart dropped',
    async (setting) => {
      vi.mocked(window.api.pty.spawn).mockRejectedValue(new Error('launch refused'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const uninstall = installCodexDetachedPaneRestartExecutor()
      try {
        seedClaudePane()
        setRunningSessionSetting(setting)
        queueFromSwitch()
        await settle()
        await settle()

        expect(window.api.pty.spawn).toHaveBeenCalledTimes(1)
        expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
      } finally {
        uninstall()
        warn.mockRestore()
      }
    }
  )

  it.each([
    { rejections: 2, bound: NEW_PTY },
    { rejections: 4, bound: OLD_PTY }
  ])(
    'under restart-all, a spawn rejected $rejections times is tried at most three times and the pane ends on $bound',
    async (row) => {
      const spawn = vi.mocked(window.api.pty.spawn)
      for (let i = 0; i < row.rejections; i += 1) {
        spawn.mockRejectedValueOnce(new Error('launch refused'))
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const uninstall = installCodexDetachedPaneRestartExecutor()
      try {
        seedClaudePane()
        setRunningSessionSetting('restart-all')
        queueFromSwitch()
        await settle()
        await settle()

        expect(spawn).toHaveBeenCalledTimes(3)
        expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
        expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
          [LEAF_ID]: row.bound
        })
      } finally {
        uninstall()
        warn.mockRestore()
      }
    }
  )

  it.each([
    { setting: 'restart-all' as const, notices: 1 },
    { setting: 'restart' as const, notices: 0 }
  ])(
    'under $setting, gives $notices notice(s) when another pane holds the session at restart',
    async (row) => {
      const warning = vi.spyOn(toast, 'warning').mockImplementation(() => 0)
      const uninstall = installCodexDetachedPaneRestartExecutor()
      try {
        seedClaudePane()
        const otherLeaf = '22222222-2222-4222-8222-222222222222'
        const state = useAppStore.getState()
        const own = state.agentStatusByPaneKey.get(makePaneKey('tab-1', LEAF_ID))!
        useAppStore.setState({
          tabsByWorktree: {
            wt1: [...state.tabsByWorktree.wt1, { ...state.tabsByWorktree.wt1[0], id: 'tab-2' }]
          },
          ptyIdsByTabId: { ...state.ptyIdsByTabId, 'tab-2': ['wt1@@other'] },
          terminalLayoutsByTabId: {
            ...state.terminalLayoutsByTabId,
            'tab-2': {
              root: { type: 'leaf', leafId: otherLeaf },
              activeLeafId: otherLeaf,
              expandedLeafId: null,
              ptyIdsByLeafId: { [otherLeaf]: 'wt1@@other' }
            }
          },
          agentStatusByPaneKey: acceptedAgentStatuses([
            [makePaneKey('tab-1', LEAF_ID), own],
            [
              makePaneKey('tab-2', otherLeaf),
              { ...own, paneKey: makePaneKey('tab-2', otherLeaf), tabId: 'tab-2' }
            ]
          ])
        })
        setRunningSessionSetting(row.setting)
        queueFromSwitch()
        await settle()

        expect(window.api.pty.spawn).not.toHaveBeenCalled()
        expect(warning).toHaveBeenCalledTimes(row.notices)
      } finally {
        uninstall()
        warning.mockRestore()
      }
    }
  )

  it('says nothing for a pane whose agent was replaced by another before the restart ran', async () => {
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => 0)
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      seedClaudePane({ agentType: 'codex' })
      setRunningSessionSetting('restart-all')
      queueFromSwitch()
      await settle()

      expect(window.api.pty.spawn).not.toHaveBeenCalled()
      expect(warning).not.toHaveBeenCalled()
    } finally {
      uninstall()
      warning.mockRestore()
    }
  })

  it('keeps the newer switch record when an older restart is handed back to a pane mounted during its lookup', async () => {
    const found = { key: 'session_id', id: SESSION_ID } as const
    const newerSwitch = async () => {
      recordQueuedClaudeRestarts([OLD_PTY], true, new Map([[OLD_PTY, found]]))
      ptyDataHandlers.set(OLD_PTY, () => {})
      return found
    }
    Object.assign(window.api.pty, { discoverClaudeSession: vi.fn(newerSwitch) })
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      seedClaudePane({ providerSession: undefined })
      recordQueuedClaudeRestarts([OLD_PTY], false, new Map([[OLD_PTY, found]]))
      useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')
      await settle()

      expect(window.api.pty.spawn).not.toHaveBeenCalled()
      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ [OLD_PTY]: 'claude' })
      expect(takeQueuedClaudeRestart(OLD_PTY)?.restartAll).toBe(true)
    } finally {
      uninstall()
      ptyDataHandlers.delete(OLD_PTY)
    }
  })

  it('tries a restart-all session again when a new restart is queued after it gave up', async () => {
    const spawn = vi.mocked(window.api.pty.spawn)
    spawn.mockRejectedValue(new Error('launch refused'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      seedClaudePane()
      setRunningSessionSetting('restart-all')
      queueFromSwitch()
      await settle()
      await settle()
      expect(spawn).toHaveBeenCalledTimes(3)

      spawn.mockReset().mockResolvedValue({ id: NEW_PTY })
      useAppStore.getState().consumePendingPaneAccountRestart(OLD_PTY)
      queueFromSwitch()
      await settle()

      expect(spawn).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    } finally {
      uninstall()
      warn.mockRestore()
    }
  })

  it.each([
    { release: 'clearTabPtyId', run: () => useAppStore.getState().clearTabPtyId('tab-1', OLD_PTY) },
    {
      release: 'closeTab',
      run: () => useAppStore.getState().closeTab('tab-1', { reason: 'pty-exit' })
    }
  ])(
    'queues nothing again for a pane released by $release while its spawn was in flight',
    async (row) => {
      const spawning = Promise.withResolvers<Awaited<ReturnType<typeof window.api.pty.spawn>>>()
      vi.mocked(window.api.pty.spawn).mockReturnValueOnce(spawning.promise)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const uninstall = installCodexDetachedPaneRestartExecutor()
      try {
        seedClaudePane({ state: 'working' })
        setRunningSessionSetting('restart-all')
        queueFromSwitch()
        await settle()
        expect(window.api.pty.spawn).toHaveBeenCalledTimes(1)

        row.run()
        spawning.reject(new Error('replaced pty gone'))
        await settle()

        expect(window.api.pty.spawn).toHaveBeenCalledTimes(1)
        expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
      } finally {
        uninstall()
        warn.mockRestore()
      }
    }
  )
})
