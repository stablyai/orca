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
