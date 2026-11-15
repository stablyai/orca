import { describe, expect, it, vi } from 'vitest'

import type { AppState } from '@/store/types'

import {
  runKillAllTerminalSurfaces,
  snapshotKillAllTerminalSurfaceIds,
  type KillAllTerminalSurfaceState
} from './kill-all-terminal-surfaces'

type TerminalRow = AppState['tabsByWorktree'][string][number]

function terminal(id: string, worktreeId: string): TerminalRow {
  return { id, worktreeId } as TerminalRow
}

function state(overrides: Partial<KillAllTerminalSurfaceState> = {}): KillAllTerminalSurfaceState {
  const state = {
    activeWorktreeId: null,
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    ...overrides
  }
  const worktreeIds = new Set([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree)
  ])
  const runtimeOwnerEnvironmentId = state.settings?.activeRuntimeEnvironmentId ?? undefined
  return {
    ...state,
    repos: [],
    worktreesByRepo: {
      'fixture-repo': [...worktreeIds].map((id) => ({
        id,
        repoId: 'fixture-repo',
        hostId: 'local',
        runtimeOwnerEnvironmentId
      }))
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set()
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

describe('runKillAllTerminalSurfaces', () => {
  it('replans after a pre-mutation close failure and keeps the failed tab as a survivor', async () => {
    const current = state({
      activeWorktreeId: 'wt',
      tabsByWorktree: { wt: [terminal('fails', 'wt'), terminal('closes', 'wt')] },
      ptyIdsByTabId: { fails: ['pty-fails'], closes: ['pty-closes'] }
    })
    const closeSurface = vi.fn(
      (
        targetId: string,
        _options: { precomputedCloseState: { terminalCountBeforeClose: number } }
      ) => {
        if (targetId === 'fails') {
          throw new Error('pre-mutation failure')
        }
        removeSurface(current, targetId)
      }
    )
    const killPty = vi.fn().mockResolvedValue(undefined)

    const summary = await runKillAllTerminalSurfaces(['fails', 'closes'], {
      getState: () => current,
      killDaemonSessions: vi.fn().mockResolvedValue({ killedCount: 0, remainingCount: 0 }),
      closeSurface,
      killPty,
      yieldToRenderer: vi.fn().mockResolvedValue(undefined),
      reportSummary: vi.fn()
    })

    expect(closeSurface.mock.calls[1]?.[1].precomputedCloseState).toEqual({
      owningWorktreeId: 'wt',
      terminalCountBeforeClose: 2,
      nextTerminalTabId: 'fails'
    })
    expect(killPty).not.toHaveBeenCalledWith('pty-fails')
    expect(killPty).toHaveBeenCalledWith('pty-closes')
    expect(snapshotKillAllTerminalSurfaceIds(current)).toEqual(['fails'])
    expect(summary).toMatchObject({
      closeAttemptCount: 2,
      absentTargetCount: 1,
      failedCloseAttemptCount: 1,
      closeYieldCount: 1
    })
  })

  it('revalidates remaining ownership after a yield before killing an exact PTY', async () => {
    let current = state({
      activeWorktreeId: 'wt',
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      tabsByWorktree: {
        wt: [terminal('first', 'wt'), terminal('second', 'wt'), terminal('third', 'wt')]
      },
      ptyIdsByTabId: {
        first: ['pty-first', 'remote:terminal-1'],
        second: ['pty-second'],
        third: ['pty-shared-after-yield', 'remote:env-1@@terminal-1']
      }
    })
    const closeSurface = vi.fn(
      (
        targetId: string,
        options: {
          precomputedRetirementPlan: {
            runtimeTerminals: unknown[]
            cleanupOnlyPtyIds: string[]
          }
          precomputedCloseState: {
            terminalCountBeforeClose: number
            nextTerminalTabId: string | null
          }
        }
      ) => {
        removeSurface(current, targetId)
        if (targetId === 'second') {
          current = { ...current }
        }
        expect(options.precomputedCloseState.terminalCountBeforeClose).toBeGreaterThan(0)
      }
    )
    const killPty = vi.fn().mockResolvedValue(undefined)
    const yieldToRenderer = vi.fn(async () => {
      current = state({
        activeWorktreeId: 'wt',
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        tabsByWorktree: {
          wt: [terminal('third', 'wt'), terminal('survivor', 'wt')]
        },
        ptyIdsByTabId: {
          third: ['pty-shared-after-yield', 'remote:env-1@@terminal-1'],
          survivor: ['pty-shared-after-yield']
        }
      })
    })

    const summary = await runKillAllTerminalSurfaces(['first', 'second', 'third'], {
      getState: () => current,
      killDaemonSessions: vi.fn().mockResolvedValue({ killedCount: 0, remainingCount: 0 }),
      closeSurface,
      killPty,
      yieldToRenderer,
      reportSummary: vi.fn()
    })

    expect(closeSurface.mock.calls.map(([targetId]) => targetId)).toEqual([
      'first',
      'second',
      'third'
    ])
    expect(closeSurface.mock.calls[2]?.[1].precomputedCloseState).toEqual({
      owningWorktreeId: 'wt',
      terminalCountBeforeClose: 2,
      nextTerminalTabId: 'survivor'
    })
    expect(closeSurface.mock.calls[2]?.[1].precomputedRetirementPlan).toMatchObject({
      runtimeTerminals: [],
      cleanupOnlyPtyIds: ['remote:env-1@@terminal-1']
    })
    expect(killPty).not.toHaveBeenCalledWith('pty-first')
    expect(killPty).not.toHaveBeenCalledWith('pty-second')
    expect(killPty).not.toHaveBeenCalledWith('pty-shared-after-yield')
    expect(snapshotKillAllTerminalSurfaceIds(current)).toEqual(['survivor'])
    expect(summary).toMatchObject({
      closeAttemptCount: 3,
      absentTargetCount: 3,
      exactKillAcceptedCount: 0,
      closeYieldCount: 1
    })
  })
})
