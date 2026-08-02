import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingSimulatorPaneShutdown,
  scheduleSimulatorPaneManagedShutdown,
  shutdownManagedSimulatorIfNoPane
} from './simulator-pane-shutdown-scheduler'

type TestTab = {
  id: string
  contentType: string
}

describe('scheduleSimulatorPaneManagedShutdown', () => {
  let tabsByWorktree: Record<string, TestTab[]>
  const shutdownManagedSimulator = vi.fn()

  const getTabsForWorktree = (worktreeId: string): TestTab[] => tabsByWorktree[worktreeId] ?? []

  beforeEach(() => {
    vi.useFakeTimers()
    shutdownManagedSimulator.mockReset()
    tabsByWorktree = {}
  })

  afterEach(() => {
    cancelPendingSimulatorPaneShutdown('wt-1')
    cancelPendingSimulatorPaneShutdown('wt-2')
    vi.useRealTimers()
  })

  it('shuts down the managed simulator after the final pane stays closed', async () => {
    tabsByWorktree = { 'wt-1': [{ id: 'terminal-1', contentType: 'terminal' }] }

    expect(
      scheduleSimulatorPaneManagedShutdown('wt-1', 'sim-1', {
        delayMs: 100,
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(99)
    expect(shutdownManagedSimulator).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(shutdownManagedSimulator).toHaveBeenCalledTimes(1)
    expect(shutdownManagedSimulator).toHaveBeenCalledWith('wt-1')
  })

  it('does not schedule shutdown for a remount while the same tab still exists', () => {
    tabsByWorktree = { 'wt-1': [{ id: 'sim-1', contentType: 'simulator' }] }

    expect(
      scheduleSimulatorPaneManagedShutdown('wt-1', 'sim-1', {
        delayMs: 100,
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).toBe(false)

    vi.advanceTimersByTime(100)
    expect(shutdownManagedSimulator).not.toHaveBeenCalled()
  })

  it('keeps the managed simulator running when another simulator tab appears before the grace expires', async () => {
    tabsByWorktree = { 'wt-1': [{ id: 'terminal-1', contentType: 'terminal' }] }

    expect(
      scheduleSimulatorPaneManagedShutdown('wt-1', 'sim-1', {
        delayMs: 100,
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).toBe(true)

    tabsByWorktree = { 'wt-1': [{ id: 'sim-2', contentType: 'simulator' }] }
    await vi.advanceTimersByTimeAsync(100)

    expect(shutdownManagedSimulator).not.toHaveBeenCalled()
  })

  it('cancels a pending shutdown when a replacement pane claims the worktree', async () => {
    tabsByWorktree = { 'wt-1': [{ id: 'terminal-1', contentType: 'terminal' }] }

    expect(
      scheduleSimulatorPaneManagedShutdown('wt-1', 'sim-1', {
        delayMs: 100,
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).toBe(true)

    cancelPendingSimulatorPaneShutdown('wt-1')
    await vi.advanceTimersByTimeAsync(100)

    expect(shutdownManagedSimulator).not.toHaveBeenCalled()
  })

  it('isolates pending shutdowns by worktree', async () => {
    tabsByWorktree = {
      'wt-1': [{ id: 'terminal-1', contentType: 'terminal' }],
      'wt-2': [{ id: 'terminal-2', contentType: 'terminal' }]
    }

    expect(
      scheduleSimulatorPaneManagedShutdown('wt-1', 'sim-1', {
        delayMs: 100,
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).toBe(true)
    expect(
      scheduleSimulatorPaneManagedShutdown('wt-2', 'sim-2', {
        delayMs: 100,
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).toBe(true)

    cancelPendingSimulatorPaneShutdown('wt-1')
    await vi.advanceTimersByTimeAsync(100)

    expect(shutdownManagedSimulator).toHaveBeenCalledTimes(1)
    expect(shutdownManagedSimulator).toHaveBeenCalledWith('wt-2')
  })

  it('immediately shuts down the managed simulator when no pane remains', async () => {
    tabsByWorktree = { 'wt-1': [{ id: 'terminal-1', contentType: 'terminal' }] }

    await expect(
      shutdownManagedSimulatorIfNoPane('wt-1', 'sim-1', {
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).resolves.toBe(true)

    expect(shutdownManagedSimulator).toHaveBeenCalledTimes(1)
    expect(shutdownManagedSimulator).toHaveBeenCalledWith('wt-1')
  })

  it('does not immediately shut down while a simulator pane still exists', async () => {
    tabsByWorktree = { 'wt-1': [{ id: 'sim-1', contentType: 'simulator' }] }

    await expect(
      shutdownManagedSimulatorIfNoPane('wt-1', 'sim-1', {
        getTabsForWorktree,
        shutdownManagedSimulator
      })
    ).resolves.toBe(false)

    expect(shutdownManagedSimulator).not.toHaveBeenCalled()
  })
})
