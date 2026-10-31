import { readDirectSetupRequest } from '@/lib/direct-work-item-setup-test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  requestDirectWorkItemSetup,
  type DirectWorkItemSetupRequest
} from './direct-work-item-setup'

const initial = useAppStore.getState()
afterEach(() => {
  useAppStore.getState().closeModal()
  useAppStore.setState(initial, true)
})
function request(): DirectWorkItemSetupRequest {
  return readDirectSetupRequest(useAppStore.getState().modalData.directSetup)
}

it('settles replacement as cancellation without closing the successor, and ignores late choices', async () => {
  const first = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, vi.fn())
  const evicted = request()
  const second = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, vi.fn())
  const successor = request()
  await expect(first).resolves.toBe('cancelled')
  expect(successor.id).not.toBe(evicted.id)
  expect(evicted.isPending()).toBe(false)
  evicted.choose('run')
  expect(request()).toBe(successor)
  successor.choose('skip')
  successor.choose('run')
  await expect(second).resolves.toBe('skip')
  expect(useAppStore.getState().activeModal).toBe('none')
})

it('cancels an owning attempt and permits a fresh attempt after cancellation', async () => {
  const abort = new AbortController()
  const first = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, vi.fn(), abort.signal)
  abort.abort()
  await expect(first).resolves.toBe('cancelled')
  const next = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, vi.fn())
  request().choose('run')
  await expect(next).resolves.toBe('run')
})

it('settles a pending choice when a different modal takes the slot', async () => {
  const pending = requestDirectWorkItemSetup('Repo', { kind: 'unavailable' }, vi.fn())
  useAppStore.getState().openModal('quick-open', { section: 'appearance' })
  await expect(pending).resolves.toBe('cancelled')
  expect(useAppStore.getState().modalData).toEqual({ section: 'appearance' })
})
