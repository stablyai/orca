import { selectCodexStaleSessionCount } from '@/components/status-bar/codex-restart-status-summary'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { provideLayoutFrameTerminalPanes } from '@/runtime/workspace-layout/frames/layout-frame-terminal-panes'

import { blocksCodexPaneInput } from '../../../codex-restart-notice-state'
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
    spawn.mockReset().mockImplementation(async ({ accountRestart }) => ({
      id:
        accountRestart?.expected.kind === 'endpoint'
          ? accountRestart.expected.ptyId.replace('old-', 'replacement-')
          : 'unexpected-spawn'
    }))
    kill.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        pty: { spawn, kill },
        runtime: {
          call: vi.fn(async ({ params }: { params: { paneKey: string } }) => {
            const paneKey = params.paneKey
            const tabId = paneKey.slice(0, paneKey.indexOf(':'))
            const leafId = paneKey.slice(paneKey.indexOf(':') + 1)
            const tab = useAppStore.getState().tabsByWorktree.wt1?.find((tab) => tab.id === tabId)
            const ptyId =
              useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
            return {
              ok: true,
              id: 'read',
              result: {
                terminal: {
                  accountRestart: {
                    hostEpoch: 'host',
                    tabCreatedAt: tab?.createdAt,
                    bindingGeneration: 0,
                    owner: ptyId ? { ptyId, incarnationId: 'inc-original' } : null
                  }
                }
              }
            }
          })
        }
      }
    })
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
      expect(selectCodexStaleSessionCount(state)).toBe(1)
      expect(state.ptyIdsByTabId[pane(2).tabId]).toEqual([pane(2).ptyId])
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
  it('asks again and frees the slot when a spawn stalls, then adopts its late result', async () => {
    const stalled = Array.from({ length: 4 }, () => Promise.withResolvers<{ id: string }>())
    spawn.mockImplementation(async ({ accountRestart }) => {
      const oldId =
        accountRestart?.expected.kind === 'endpoint' ? accountRestart.expected.ptyId : null
      const index = stalled.findIndex((_, position) => pane(position + 1).ptyId === oldId)
      return stalled[index]?.promise ?? { id: pane(5).replacementId }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedPanes(5)
    acceptRestarts([1, 2, 3, 4, 5])
    const uninstall = installCodexDetachedPaneRestartExecutor()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(spawn).toHaveBeenCalledTimes(4)
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)

      await vi.advanceTimersByTimeAsync(STALLED_DETACHED_RESTART_MS)
      expectRestarted(5)
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(4)

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
