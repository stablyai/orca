// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'

type InventoryState = 'pending' | 'successful' | 'failed'
type MockState = {
  inventory: InventoryState
  refused: boolean
  readLocalAgentInventory: () => { ids: null; state: InventoryState }
  isLocalAgentInventoryRefused: () => boolean
  ensureDetectedAgentsForPicker: (worktreeId?: string | null) => Promise<unknown[]>
}

const mocks = vi.hoisted(() => ({ ensure: vi.fn(async (_worktreeId?: string | null) => []) }))
const store = vi.hoisted(() => {
  const holder: { current: unknown } = { current: null }
  return holder
})
vi.mock('@/store', () => ({
  get useAppStore() {
    return store.current
  }
}))

import { useAgentPickerRefusedWake } from './use-agent-picker-refused-wake'

function makeStore(refused: boolean) {
  const useStore = create<MockState>()((_set, get) => ({
    inventory: 'failed',
    refused,
    readLocalAgentInventory: () => ({ ids: null, state: get().inventory }),
    isLocalAgentInventoryRefused: () => get().refused,
    ensureDetectedAgentsForPicker: mocks.ensure
  }))
  store.current = useStore
  return useStore
}

const LOCAL = { kind: 'local', worktreeId: 'wt-1' } as const

beforeEach(() => {
  mocks.ensure.mockClear()
})

it('wakes a refused WSL list once per open, even when the woken probe fails again (E9)', () => {
  const useStore = makeStore(true)
  const { rerender } = renderHook(({ open }) => useAgentPickerRefusedWake(open, LOCAL), {
    initialProps: { open: true }
  })
  expect(mocks.ensure).toHaveBeenCalledTimes(1)
  expect(mocks.ensure).toHaveBeenCalledWith('wt-1')
  // The wake probe runs (pending) and fails again while the picker stays open.
  act(() => useStore.setState({ inventory: 'pending' }))
  act(() => useStore.setState({ inventory: 'failed' }))
  act(() => useStore.setState({ inventory: 'pending' }))
  act(() => useStore.setState({ inventory: 'failed' }))
  expect(mocks.ensure).toHaveBeenCalledTimes(1)

  // Closing and reopening is a new user act.
  rerender({ open: false })
  rerender({ open: true })
  expect(mocks.ensure).toHaveBeenCalledTimes(2)
})

it('never retries a native or non-refusal failure while the picker is open', () => {
  const useStore = makeStore(false)
  renderHook(() => useAgentPickerRefusedWake(true, LOCAL))
  act(() => useStore.setState({ inventory: 'pending' }))
  act(() => useStore.setState({ inventory: 'failed' }))
  expect(mocks.ensure).not.toHaveBeenCalled()
})

it('wakes nothing while closed or for a remote host', () => {
  makeStore(true)
  renderHook(() => useAgentPickerRefusedWake(false, LOCAL))
  renderHook(() => useAgentPickerRefusedWake(true, { kind: 'ssh', connectionId: 'ssh-1' }))
  expect(mocks.ensure).not.toHaveBeenCalled()
})
