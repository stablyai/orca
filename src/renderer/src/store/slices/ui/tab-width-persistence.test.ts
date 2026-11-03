import { beforeEach, expect, it, vi } from 'vitest'
import type * as TabWidthPersistence from './tab-width-persistence'

const setWithAck = vi.fn()

async function loadPersistence(): Promise<typeof TabWidthPersistence> {
  vi.resetModules()
  vi.stubGlobal('window', { api: { ui: { setWithAck } } })
  return import('./tab-width-persistence')
}

beforeEach(() => {
  setWithAck.mockReset()
})

it('keeps a rejected patch pending and resends it with the next edit', async () => {
  const { persistTabWidthChange, pendingTabWidthChanges } = await loadPersistence()
  setWithAck.mockRejectedValueOnce(new Error('offline'))
  persistTabWidthChange('a', 400)
  await vi.waitFor(() => expect(setWithAck).toHaveBeenCalledTimes(1))
  await Promise.resolve()
  expect(pendingTabWidthChanges()).toEqual({ a: 400 })

  setWithAck.mockResolvedValueOnce(undefined)
  persistTabWidthChange('b', null)
  expect(setWithAck).toHaveBeenLastCalledWith({ tabWidthsById: { a: 400, b: null } })
  await vi.waitFor(() => expect(pendingTabWidthChanges()).toEqual({}))
})

it('keeps a newer edit pending when an older send for the same tab settles', async () => {
  const { persistTabWidthChange, pendingTabWidthChanges } = await loadPersistence()
  let resolveFirst!: () => void
  setWithAck.mockReturnValueOnce(new Promise<void>((resolve) => (resolveFirst = resolve)))
  setWithAck.mockReturnValueOnce(new Promise<void>(() => {}))
  persistTabWidthChange('a', 300)
  persistTabWidthChange('a', 500)
  resolveFirst()
  await Promise.resolve()
  await Promise.resolve()
  expect(pendingTabWidthChanges()).toEqual({ a: 500 })
})
