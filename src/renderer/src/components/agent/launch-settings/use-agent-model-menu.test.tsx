// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { useAgentModelMenu } from './use-agent-model-menu'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
const source = {
  scope: { target: { kind: 'local' as const }, agent: 'codex', worktree: 'id:settings-follow' },
  coherentCatalog: true
}
afterEach(() => {
  cleanup()
  resetHostModelCatalogSnapshotsForTests()
  mocks.call.mockReset()
})

it('follows real expired waits until failure and keeps last-good display explicitly failed', async () => {
  const failed = Promise.withResolvers<unknown>()
  const late = Promise.withResolvers<unknown>()
  const admitted = Promise.withResolvers<void>()
  mocks.call
    .mockResolvedValueOnce({
      origin: 'probe',
      fetchedAt: 1,
      listingInProgress: true,
      models: [{ id: 'last-good', label: 'Last good', isDefault: false, efforts: [] }]
    })
    .mockResolvedValueOnce({
      origin: 'probe',
      fetchedAt: 2,
      listingInProgress: true,
      waitExpired: true,
      models: [{ id: 'last-good', label: 'Last good', isDefault: false, efforts: [] }]
    })
    .mockReturnValueOnce(failed.promise)
  const hook = renderHook(({ open }) => useAgentModelMenu('codex', undefined, source, open), {
    initialProps: { open: true }
  })
  await waitFor(() => expect(hook.result.current.rows.map(({ id }) => id)).toEqual(['last-good']))
  await act(async () => {
    failed.reject(new Error('offline'))
  })
  await waitFor(() => expect(hook.result.current.readOutcome).toBe('failed'))
  expect(hook.result.current.status).toBe('listed')
  expect(hook.result.current.fallbackAfterFailure).toBe(false)
  expect(hook.result.current.rows.map(({ id }) => id)).toEqual(['last-good'])
  hook.rerender({ open: false })
  mocks.call.mockImplementationOnce(() => {
    admitted.resolve()
    return late.promise
  })
  hook.rerender({ open: true })
  await admitted.promise
  hook.rerender({ open: false })
  // Any forbidden continuation would replace these held rows with the unknown fallback.
  mocks.call.mockResolvedValue({ origin: 'unknown' })
  await act(async () => {
    late.resolve({ origin: 'unknown', listingInProgress: true, waitExpired: true })
  })
  expect(hook.result.current.rows.map(({ id }) => id)).toEqual(['last-good'])
  expect(hook.result.current.status).toBe('listed')
})

it('keeps an unread closed control idle and shows the placeholder only after opening', async () => {
  mocks.call.mockImplementation(() => {
    throw new Error('unavailable')
  })
  const hook = renderHook(
    ({ open }) => useAgentModelMenu('codex', { model: 'saved-only' }, source, open),
    { initialProps: { open: false } }
  )
  await act(async () => {})
  expect(hook.result.current.status).toBe('builtin')
  expect(hook.result.current.readOutcome).toBeUndefined()
  expect(hook.result.current.descriptors.find(({ id }) => id === 'model')?.kind).toMatchObject({
    currentValue: 'saved-only'
  })
  const pending = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValue(pending.promise)
  hook.rerender({ open: true })
  expect(hook.result.current.status).toBe('listing')
  expect(hook.result.current.fallbackAfterFailure).toBe(false)
  hook.unmount()
  await act(async () => {
    pending.resolve({ origin: 'unknown' })
  })
})
