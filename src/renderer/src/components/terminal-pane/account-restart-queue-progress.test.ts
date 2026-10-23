import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import { registerRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { awaitsCodexRestartAnswer, blocksCodexPaneInput } from '../codex-restart-notice-state'
import {
  installCodexDetachedPaneRestartExecutor,
  resetCodexDetachedPaneRestartExecutorForTests
} from './codex-detached-pane-restart-scheduler'
import { STALLED_DETACHED_RESTART_MS } from './detached-pane-restart-slots'

const spawn = vi.fn<typeof window.api.pty.spawn>()
const kill = vi.fn<typeof window.api.pty.kill>()

function pane(index: number) {
  return {
    tabId: `restart-tab-${index}`,
    ptyId: `wt1@@old-${index}`,
    replacementId: `wt1@@replacement-${index}`,
    leafId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  }
}

function seedPanes(count: number): void {
  const tabs: AppState['tabsByWorktree'][string] = []
  const layouts: AppState['terminalLayoutsByTabId'] = {}
  const ptyIdsByTabId: AppState['ptyIdsByTabId'] = {}
  for (let index = 1; index <= count; index += 1) {
    const { tabId, ptyId, leafId } = pane(index)
    tabs.push({
      id: tabId,
      worktreeId: 'wt1',
      ptyId,
      title: 'codex',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: index,
      launchAgent: 'codex'
    })
    ptyIdsByTabId[tabId] = [ptyId]
    layouts[tabId] = {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: ptyId }
    }
  }
  useAppStore.setState({
    tabsByWorktree: { wt1: tabs },
    terminalLayoutsByTabId: layouts,
    ptyIdsByTabId
  })
  provideLayoutFrameTerminalPanes({
    holdsTerminalPane: () => false,
    terminalTab: (worktreeId, tabId) => {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      const layout = layouts[tabId]
      if (worktreeId !== 'wt1' || !tab || !layout) {
        return undefined
      }
      return {
        id: tab.id,
        kind: 'terminal',
        entityId: tab.id,
        executionHostId: 'local',
        createdAt: tab.createdAt,
        customTitle: null,
        color: null,
        terminal: {
          root: layout.root,
          panes: Object.entries(layout.ptyIdsByLeafId ?? {}).map(([leafId, ptyId]) => ({
            leafId,
            ptyId
          }))
        }
      }
    }
  })
}

function acceptRestarts(indices: number[]): void {
  const ids = indices.map((index) => pane(index).ptyId)
  useAppStore.getState().markCodexRestartNotices(
    ids.map((ptyId) => ({
      ptyId,
      previousAccountLabel: 'Account A',
      nextAccountLabel: 'Account B'
    }))
  )
  useAppStore.getState().queuePaneAccountRestarts(ids, 'codex')
}

function expectRestarted(index: number): void {
  const { tabId, ptyId, leafId, replacementId } = pane(index)
  const state = useAppStore.getState()
  expect(state.ptyIdsByTabId[tabId]).toEqual([replacementId])
  expect(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]).toBe(replacementId)
  expect(blocksCodexPaneInput(state.codexRestartNoticeByPtyId[ptyId])).toBe(false)
  expect(blocksCodexPaneInput(state.codexRestartNoticeByPtyId[replacementId])).toBe(false)
}

describe('accepted account restart queue progress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetCodexDetachedPaneRestartExecutorForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    spawn.mockReset().mockImplementation(async ({ replacesPtyId }) => ({
      id: replacesPtyId?.replace('old-', 'replacement-') ?? 'unexpected-spawn'
    }))
    kill.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { pty: { spawn, kill } } })
  })

  afterEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    provideLayoutFrameTerminalPanes({
      holdsTerminalPane: () => false,
      terminalTab: () => undefined
    })
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('finishes later accepted panes while the first spawn stays pending and a second fails', async () => {
    const first = Promise.withResolvers<{ id: string }>()
    spawn.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('launch refused'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedPanes(7)
    acceptRestarts([1, 2, 3, 4, 5, 6, 7])
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      await vi.advanceTimersByTimeAsync(0)

      for (const index of [3, 4, 5, 6, 7]) {
        expectRestarted(index)
      }
      const state = useAppStore.getState()
      expect(state.ptyIdsByTabId[pane(1).tabId]).toEqual([pane(1).ptyId])
      expect(awaitsCodexRestartAnswer(state.codexRestartNoticeByPtyId[pane(2).ptyId])).toBe(true)
      expect(state.ptyIdsByTabId[pane(2).tabId]).toEqual([pane(2).ptyId])
      expect(state.pendingPaneAccountRestarts).toEqual({})
      expect(spawn).toHaveBeenCalledTimes(7)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      first.resolve({ id: pane(1).replacementId })
      await vi.advanceTimersByTimeAsync(0)
      uninstall()
      warn.mockRestore()
    }
    expectRestarted(1)
  })

  it('admits later requests within a shared limit and rechecks mounted ownership as slots free', async () => {
    const pending = Array.from({ length: 7 }, () => Promise.withResolvers<{ id: string }>())
    spawn.mockImplementation(({ replacesPtyId }) => {
      const index = pending.findIndex((_, position) => pane(position + 1).ptyId === replacesPtyId)
      const result = pending[index]
      if (!result) {
        throw new Error('unexpected spawn')
      }
      return result.promise
    })
    seedPanes(7)
    acceptRestarts([1])
    const uninstall = installCodexDetachedPaneRestartExecutor()
    let unregister = () => {}
    try {
      await vi.advanceTimersByTimeAsync(0)
      acceptRestarts([2, 3, 4, 5, 6, 7])
      await vi.advanceTimersByTimeAsync(0)

      expect(spawn).toHaveBeenCalledTimes(4)
      expect(Object.keys(useAppStore.getState().pendingPaneAccountRestarts)).toEqual(
        [5, 6, 7].map((index) => pane(index).ptyId)
      )
      unregister = registerRuntimeTerminalTab({
        tabId: pane(5).tabId,
        worktreeId: 'wt1',
        getManager: () => null,
        getContainer: () => null,
        getPtyIdForPane: () => pane(5).ptyId,
        getTabWideAgentHintLeafId: () => null
      })
      pending[1]?.resolve({ id: pane(2).replacementId })
      await vi.advanceTimersByTimeAsync(0)

      expectRestarted(2)
      expect(spawn).toHaveBeenCalledTimes(5)
      expect(spawn.mock.calls[4]?.[0].replacesPtyId).toBe(pane(6).ptyId)
      expect(useAppStore.getState().pendingPaneAccountRestarts[pane(5).ptyId]).toBe('codex')
      expect(useAppStore.getState().pendingPaneAccountRestarts[pane(7).ptyId]).toBe('codex')
      expect(kill).not.toHaveBeenCalled()
    } finally {
      for (const [position, result] of pending.entries()) {
        result.resolve({ id: pane(position + 1).replacementId })
      }
      await vi.advanceTimersByTimeAsync(0)
      uninstall()
      unregister()
    }
    for (const index of [1, 2, 3, 4, 6, 7]) {
      expectRestarted(index)
    }
    expect(useAppStore.getState().ptyIdsByTabId[pane(5).tabId]).toEqual([pane(5).ptyId])
  })

  it('resumes queued work when a claim from an earlier executor installation settles', async () => {
    const firstBatch = Promise.withResolvers<{ id: string }>()
    spawn.mockImplementationOnce(() => firstBatch.promise)
    seedPanes(5)
    acceptRestarts([1])
    const firstUninstall = installCodexDetachedPaneRestartExecutor()
    await vi.advanceTimersByTimeAsync(0)
    firstUninstall()
    acceptRestarts([2, 3, 4, 5])
    const pending = Array.from({ length: 4 }, () => Promise.withResolvers<{ id: string }>())
    spawn.mockImplementation(({ replacesPtyId }) => {
      const index = pending.findIndex((_, position) => pane(position + 2).ptyId === replacesPtyId)
      const result = pending[index]
      if (!result) {
        throw new Error('unexpected spawn')
      }
      return result.promise
    })
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(spawn).toHaveBeenCalledTimes(4)
      firstBatch.resolve({ id: pane(1).replacementId })
      await vi.advanceTimersByTimeAsync(0)

      expectRestarted(1)
      expect(spawn).toHaveBeenCalledTimes(5)
      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    } finally {
      uninstall()
      firstBatch.resolve({ id: pane(1).replacementId })
      for (const [position, result] of pending.entries()) {
        result.resolve({ id: pane(position + 2).replacementId })
      }
      await vi.advanceTimersByTimeAsync(0)
    }
  })
  it('asks again and frees the slot when a spawn stalls, then adopts its late result', async () => {
    const stalled = Array.from({ length: 4 }, () => Promise.withResolvers<{ id: string }>())
    spawn.mockImplementation(async ({ replacesPtyId }) => {
      const index = stalled.findIndex((_, position) => pane(position + 1).ptyId === replacesPtyId)
      return stalled[index]?.promise ?? { id: pane(5).replacementId }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedPanes(5)
    acceptRestarts([1, 2, 3, 4, 5])
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(spawn).toHaveBeenCalledTimes(4)
      expect(
        awaitsCodexRestartAnswer(useAppStore.getState().codexRestartNoticeByPtyId[pane(1).ptyId])
      ).toBe(false)

      await vi.advanceTimersByTimeAsync(STALLED_DETACHED_RESTART_MS)
      expectRestarted(5)
      expect(
        awaitsCodexRestartAnswer(useAppStore.getState().codexRestartNoticeByPtyId[pane(1).ptyId])
      ).toBe(true)

      stalled[0]?.resolve({ id: pane(1).replacementId })
      await vi.advanceTimersByTimeAsync(0)
      expectRestarted(1)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      for (const [position, result] of stalled.entries()) {
        result.resolve({ id: pane(position + 1).replacementId })
      }
      await vi.advanceTimersByTimeAsync(0)
      uninstall()
      warn.mockRestore()
    }
  })
})
