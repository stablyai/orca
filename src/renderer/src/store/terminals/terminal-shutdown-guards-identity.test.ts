import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createTerminalShutdownGuardController } from './terminal-shutdown-guards'

vi.mock('@/components/terminal-pane/pty-transport', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/components/terminal-pane/terminal-parked-watcher-registry', () => ({
  disposeParkedTerminalWatchersForPtyIds: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-shutdown-exit-deferral', () => ({
  clearCommittedPtyShutdownSettlements: vi.fn(),
  hasCommittedPtyShutdownSettlement: vi.fn(() => false),
  markCommittedPtyShutdowns: vi.fn(),
  noteCommittedPtyShutdownSettlements: vi.fn(),
  settleDeferredPtyShutdownExits: vi.fn()
}))

function harness(initial: Partial<AppState>, exitGuardPtyIds: readonly string[]) {
  let current = initial as AppState
  const set = vi.fn((update: unknown) => {
    const patch =
      typeof update === 'function' ? (update as (s: AppState) => object)(current) : update
    current = { ...current, ...(patch as object) }
  })
  const guards = createTerminalShutdownGuardController({
    exitGuardPtyIds,
    get: (() => current) as never,
    keepIdentifiers: false,
    rendererShutdownPtyIds: exitGuardPtyIds,
    runtimeEnvironmentId: null,
    set: set as never,
    tabs: []
  })
  return { guards, set, state: () => current }
}

describe('markShutdownPending identity', () => {
  it('does not write the store when there is nothing to guard', () => {
    const { guards, set } = harness({ suppressedPtyExitIds: {}, pendingPtyShutdownIds: {} }, [])

    guards.markShutdownPending()

    expect(set).not.toHaveBeenCalled()
  })

  it('still counts a pending owner when every id is already suppressed', () => {
    const suppressedPtyExitIds: Record<string, true> = { 'pty-1': true }
    const { guards, state } = harness(
      { suppressedPtyExitIds, pendingPtyShutdownIds: { 'pty-1': 1 } },
      ['pty-1']
    )

    guards.markShutdownPending()

    expect(state().suppressedPtyExitIds).toBe(suppressedPtyExitIds)
    expect(state().pendingPtyShutdownIds).toEqual({ 'pty-1': 2 })
  })

  it('suppresses the ids that were not yet suppressed', () => {
    const { guards, state } = harness(
      { suppressedPtyExitIds: { 'pty-1': true }, pendingPtyShutdownIds: {} },
      ['pty-1', 'pty-2']
    )

    guards.markShutdownPending()

    expect(state().suppressedPtyExitIds).toEqual({ 'pty-1': true, 'pty-2': true })
    expect(state().pendingPtyShutdownIds).toEqual({ 'pty-1': 1, 'pty-2': 1 })
  })
})
