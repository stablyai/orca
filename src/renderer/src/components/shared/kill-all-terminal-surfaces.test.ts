import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore, type AppState } from '@/store'
import {
  runKillAllTerminalSurfaces,
  snapshotKillAllTerminalSurfaceIds,
  type KillAllTerminalSurfaceState
} from './kill-all-terminal-surfaces'

type TerminalRow = AppState['tabsByWorktree'][string][number]
type UnifiedRow = AppState['unifiedTabsByWorktree'][string][number]

function terminal(id: string, worktreeId: string): TerminalRow {
  return { id, worktreeId } as TerminalRow
}

function unified(
  id: string,
  entityId: string,
  worktreeId: string,
  contentType: UnifiedRow['contentType'] = 'terminal'
): UnifiedRow {
  return { id, entityId, worktreeId, contentType } as UnifiedRow
}

function state(overrides: Partial<KillAllTerminalSurfaceState> = {}): KillAllTerminalSurfaceState {
  return {
    activeWorktreeId: null,
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    ...overrides
  }
}

function removeSurface(current: KillAllTerminalSurfaceState, targetId: string): void {
  current.tabsByWorktree = Object.fromEntries(
    Object.entries(current.tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.filter((tab) => tab.id !== targetId)
    ])
  )
  current.unifiedTabsByWorktree = Object.fromEntries(
    Object.entries(current.unifiedTabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.filter(
        (tab) =>
          tab.contentType !== 'terminal' || (tab.entityId !== targetId && tab.id !== targetId)
      )
    ])
  )
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('snapshotKillAllTerminalSurfaceIds', () => {
  it('deduplicates terminal entities across legacy, unified, split, and floating state', () => {
    const snapshot = snapshotKillAllTerminalSurfaceIds(
      state({
        tabsByWorktree: {
          'wt-a': [terminal('tab-a', 'wt-a'), terminal('split-tab', 'wt-a')],
          'wt-b': [terminal('tab-b', 'wt-b')],
          [FLOATING_TERMINAL_WORKTREE_ID]: [terminal('floating-tab', FLOATING_TERMINAL_WORKTREE_ID)]
        },
        unifiedTabsByWorktree: {
          'wt-a': [
            unified('visible-a', 'tab-a', 'wt-a'),
            unified('unified-only', 'unified-only', 'wt-a'),
            unified('editor-a', 'file-a', 'wt-a', 'editor')
          ],
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            unified('floating-visible', 'floating-tab', FLOATING_TERMINAL_WORKTREE_ID)
          ]
        },
        ptyIdsByTabId: {
          'split-tab': ['pty-left', 'pty-right']
        }
      })
    )

    expect(snapshot).toEqual(['tab-a', 'split-tab', 'tab-b', 'floating-tab', 'unified-only'])
  })
})

describe('runKillAllTerminalSurfaces', () => {
  it('resolves current bindings and ownership after management settles, then closes active last', async () => {
    const management = deferred<{ killedCount: number; remainingCount: number }>()
    const lastExactKill = deferred<void>()
    let current = state({
      activeWorktreeId: 'wt-old-active',
      tabsByWorktree: {
        'wt-old-active': [terminal('moved-target', 'wt-old-active')],
        'wt-background': [
          terminal('background-target', 'wt-background'),
          terminal('missing-target', 'wt-background')
        ]
      },
      unifiedTabsByWorktree: {
        'wt-background': [unified('unified-target', 'unified-only-target', 'wt-background')]
      },
      ptyIdsByTabId: {
        'moved-target': ['stale-pty'],
        'background-target': ['stale-background-pty'],
        'missing-target': ['stale-missing-pty'],
        'unified-only-target': ['stale-unified-pty']
      }
    })
    const targetIds = snapshotKillAllTerminalSurfaceIds(current)
    const calls: string[] = []
    const killDaemonSessions = vi.fn(() => management.promise)
    const closeSurface = vi.fn((targetId: string) => {
      calls.push(`close:${targetId}`)
      removeSurface(current, targetId)
    })
    const killPty = vi.fn((ptyId: string) => {
      calls.push(`kill:${ptyId}`)
      if (ptyId === 'pty-unified') {
        return Promise.reject(new Error('provider unavailable'))
      }
      if (ptyId === 'ssh:host@@pty-last') {
        return lastExactKill.promise
      }
      return Promise.resolve()
    })
    const reportSummary = vi.fn()

    const completion = runKillAllTerminalSurfaces(targetIds, {
      getState: () => current,
      killDaemonSessions,
      closeSurface,
      killPty,
      reportSummary
    })

    expect(killDaemonSessions).toHaveBeenCalledTimes(1)
    expect(closeSurface).not.toHaveBeenCalled()

    current = state({
      activeWorktreeId: 'wt-new-active',
      tabsByWorktree: {
        'wt-background': [terminal('background-target', 'wt-background')],
        'wt-new-active': [
          {
            ...terminal('moved-target', 'wt-new-active'),
            ptyId: 'tab-restore-hint'
          },
          terminal('later-tab', 'wt-new-active')
        ]
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          unified('unified-target-moved', 'unified-only-target', FLOATING_TERMINAL_WORKTREE_ID)
        ],
        'wt-new-active': [unified('later-visible', 'later-tab', 'wt-new-active')]
      },
      ptyIdsByTabId: {
        'background-target': ['pty-shared', 'remote:runtime-only'],
        'unified-only-target': ['pty-unified', 'pty-shared'],
        'moved-target': ['ssh:host@@pty-last', 'pty-shared'],
        'later-tab': ['pty-later']
      }
    })
    ;(
      current as KillAllTerminalSurfaceState & {
        terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
      }
    ).terminalLayoutsByTabId = {
      'moved-target': { ptyIdsByLeafId: { leaf: 'layout-restore-hint' } }
    }
    management.resolve({ killedCount: 2, remainingCount: 1 })
    await vi.waitFor(() => expect(killPty).toHaveBeenCalledTimes(3))

    expect(closeSurface.mock.calls).toEqual([
      ['background-target', { force: true }],
      ['unified-only-target', { force: true }],
      ['moved-target', { force: true }]
    ])
    expect(calls.slice(0, 3)).toEqual([
      'close:background-target',
      'close:unified-only-target',
      'close:moved-target'
    ])
    expect(killPty).toHaveBeenCalledWith('pty-shared')
    expect(killPty).toHaveBeenCalledWith('pty-unified')
    expect(killPty).toHaveBeenCalledWith('ssh:host@@pty-last')
    expect(killPty).not.toHaveBeenCalledWith('remote:runtime-only')
    expect(killPty).not.toHaveBeenCalledWith('pty-later')
    expect(killPty).not.toHaveBeenCalledWith('stale-pty')
    expect(killPty).not.toHaveBeenCalledWith('tab-restore-hint')
    expect(killPty).not.toHaveBeenCalledWith('layout-restore-hint')
    expect(snapshotKillAllTerminalSurfaceIds(current)).toEqual(['later-tab'])

    let settled = false
    void completion.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    lastExactKill.resolve()

    await expect(completion).resolves.toMatchObject({
      targetCount: 4,
      closeAttemptCount: 3,
      absentTargetCount: 4,
      failedCloseAttemptCount: 0,
      exactKillAcceptedCount: 2,
      exactKillRejectedCount: 1,
      daemon: { status: 'fulfilled', killedCount: 2, remainingCount: 1 }
    })
    expect(reportSummary).toHaveBeenCalledTimes(1)
  })

  it('still closes and issues exact kills when daemon management rejects', async () => {
    let current = state({
      tabsByWorktree: { wt: [terminal('target', 'wt'), terminal('later', 'wt')] },
      ptyIdsByTabId: { target: ['local-pty'], later: ['later-pty'] }
    })
    const closeSurface = vi.fn((targetId: string) => removeSurface(current, targetId))
    const killPty = vi.fn().mockResolvedValue(undefined)

    const summary = await runKillAllTerminalSurfaces(['target'], {
      getState: () => current,
      killDaemonSessions: vi.fn().mockRejectedValue(new Error('management unavailable')),
      closeSurface,
      killPty,
      reportSummary: vi.fn()
    })

    expect(summary.daemon).toEqual({ status: 'rejected' })
    expect(summary.absentTargetCount).toBe(1)
    expect(closeSurface).toHaveBeenCalledWith('target', { force: true })
    expect(killPty).toHaveBeenCalledWith('local-pty')
    expect(snapshotKillAllTerminalSurfaceIds(current)).toEqual(['later'])
  })

  it('reports the informational zero state without provider fanout', async () => {
    const killDaemonSessions = vi.fn().mockResolvedValue({ killedCount: 0, remainingCount: 0 })
    const closeSurface = vi.fn()
    const killPty = vi.fn()

    const summary = await runKillAllTerminalSurfaces([], {
      getState: () => state(),
      killDaemonSessions,
      closeSurface,
      killPty,
      reportSummary: vi.fn()
    })

    expect(summary).toMatchObject({
      targetCount: 0,
      closeAttemptCount: 0,
      absentTargetCount: 0,
      exactKillAcceptedCount: 0,
      exactKillRejectedCount: 0,
      daemon: { status: 'fulfilled', killedCount: 0, remainingCount: 0 }
    })
    expect(killDaemonSessions).toHaveBeenCalledTimes(1)
    expect(closeSurface).not.toHaveBeenCalled()
    expect(killPty).not.toHaveBeenCalled()
  })

  it('uses one daemon management call and never inventories sessions afterward', async () => {
    const killAll = vi.fn().mockResolvedValue({ killedCount: 0, remainingCount: 0 })
    const listSessions = vi.fn()
    vi.stubGlobal('window', {
      api: {
        pty: {
          kill: vi.fn(),
          management: { killAll, listSessions }
        }
      }
    })
    try {
      await runKillAllTerminalSurfaces([], {
        getState: () => state(),
        reportSummary: vi.fn()
      })

      expect(killAll).toHaveBeenCalledTimes(1)
      expect(listSessions).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('settles each close attempt and verifies final absence in both tab stores', async () => {
    const current = state({
      tabsByWorktree: {
        wt: [terminal('throws-after-close', 'wt'), terminal('remains', 'wt')]
      },
      unifiedTabsByWorktree: {
        wt: [unified('remains-visible', 'remains', 'wt')]
      }
    })
    const closeSurface = vi.fn((targetId: string) => {
      if (targetId === 'throws-after-close') {
        removeSurface(current, targetId)
        throw new Error('post-close store failure')
      }
    })

    const summary = await runKillAllTerminalSurfaces(['throws-after-close', 'remains'], {
      getState: () => current,
      killDaemonSessions: vi.fn().mockResolvedValue({ killedCount: 0, remainingCount: 0 }),
      closeSurface,
      killPty: vi.fn(),
      reportSummary: vi.fn()
    })

    expect(closeSurface).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({
      absentTargetCount: 1,
      failedCloseAttemptCount: 2
    })
  })

  it('records bounded count and latency evidence for 100 terminal tabs', async () => {
    const tabs = Array.from({ length: 100 }, (_, index) => terminal(`tab-${index}`, 'wt'))
    const ptyIdsByTabId = Object.fromEntries(tabs.map((tab, index) => [tab.id, [`pty-${index}`]]))
    const previousState = useAppStore.getState()
    useAppStore.setState({
      activeWorktreeId: null,
      tabsByWorktree: { wt: tabs },
      unifiedTabsByWorktree: {},
      ptyIdsByTabId
    })
    let zustandWrites = 0
    const unsubscribe = useAppStore.subscribe(() => {
      zustandWrites += 1
    })
    const killPty = vi.fn().mockResolvedValue(undefined)
    try {
      const summary = await runKillAllTerminalSurfaces(snapshotKillAllTerminalSurfaceIds(), {
        killDaemonSessions: vi.fn().mockResolvedValue({ killedCount: 0, remainingCount: 0 }),
        killPty,
        reportSummary: vi.fn()
      })

      expect(summary.closeAttemptCount).toBe(100)
      expect(summary.absentTargetCount).toBe(100)
      expect(summary.exactKillAcceptedCount).toBe(100)
      expect(summary.closeDurationMs).toBeGreaterThanOrEqual(0)
      expect(summary.maxCloseBatchDurationMs).toBeLessThanOrEqual(50)
      expect(summary.closeYieldCount).toBe(49)
      expect(summary.closePhaseExceededLongTaskBudget).toBe(false)
      expect(zustandWrites).toBeGreaterThanOrEqual(100)
      expect(killPty).toHaveBeenCalledTimes(100)
    } finally {
      unsubscribe()
      useAppStore.setState(previousState, true)
    }
  })
})
