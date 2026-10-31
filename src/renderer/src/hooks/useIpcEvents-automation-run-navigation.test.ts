import { expect, it, vi } from 'vitest'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'
it('hands the startup queued target and later real openRun listener target to visible run navigation', async () => {
  const first = { automationId: 'a', runId: 'r', hostId: 'runtime:host' }
  const second = { ...first, runId: 'r2' }
  const pending = Promise.withResolvers<typeof first | null>()
  const consume = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(second)
    .mockResolvedValue(null)
  const setPending = vi.fn()
  const open = vi.fn()
  const listener = { current: () => {} }
  const h = await loadIpcEventsHarness(
    createHarnessStoreState({
      tabsByWorktree: {},
      setPendingAutomationRunNavigation: setPending,
      openAutomationsPage: open
    }),
    {
      automationsApi: {
        consumePendingOpenRun: consume,
        onOpenRun: (callback: () => void) => {
          listener.current = callback
          return () => {}
        }
      }
    }
  )
  h.useIpcEvents()
  expect(setPending).not.toHaveBeenCalled()
  pending.resolve(first)
  await vi.waitFor(() => expect(setPending).toHaveBeenCalledWith(first))
  expect(open).toHaveBeenCalledOnce()
  listener.current()
  await vi.waitFor(() => expect(setPending).toHaveBeenLastCalledWith(second))
  expect(open).toHaveBeenCalledTimes(2)
  listener.current()
  await Promise.resolve()
  expect(open).toHaveBeenCalledTimes(2)
})

it('finishes an already consumed target across cleanup/remount and deduplicates listener plus startup pulls', async () => {
  const target = { automationId: 'a', runId: 'failed', hostId: 'runtime:box', pairingRevision: 7 }
  const answer = Promise.withResolvers<typeof target | null>()
  let queued: typeof target | null = target
  const consume = vi.fn(() => {
    const value = queued
    queued = null
    return value ? answer.promise : Promise.resolve(null)
  })
  const listeners = new Set<() => void>()
  const setPending = vi.fn()
  const open = vi.fn()
  const seen = vi.fn()
  await loadIpcEventsHarness(
    createHarnessStoreState({
      tabsByWorktree: {},
      setPendingAutomationRunNavigation: setPending,
      openAutomationsPage: open
    }),
    {
      automationsApi: {
        consumePendingOpenRun: consume,
        runSeen: seen,
        onOpenRun: (listener: () => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }
      }
    }
  )
  const { installAppLifetimeIpcEvents } = await import('./ipc-events/app-lifetime-ipc-bridge')
  const stop = installAppLifetimeIpcEvents()
  listeners.forEach((listener) => listener())
  stop()
  expect(listeners.size).toBe(0)
  const stopAgain = installAppLifetimeIpcEvents()
  listeners.forEach((listener) => listener())
  answer.resolve(target)
  await vi.waitFor(() => expect(setPending).toHaveBeenCalledExactlyOnceWith(target))
  expect(open).toHaveBeenCalledOnce()
  expect(consume).toHaveBeenCalledTimes(4)
  expect(seen).not.toHaveBeenCalled()
  stopAgain()
  expect(listeners.size).toBe(0)
})
