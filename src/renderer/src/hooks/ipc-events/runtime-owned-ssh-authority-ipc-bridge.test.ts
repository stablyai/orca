import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeOwnedSshAuthority } from '../../../../shared/runtime-owned-ssh-authority'
import { registerRuntimeOwnedSshAuthorityIpcBridge } from './runtime-owned-ssh-authority-ipc-bridge'

const targetId = 'runtime-ssh-fixture'
const unsubs: (() => void)[] = []
beforeEach(() =>
  useAppStore.setState({
    runtimeOwnedSshConnectionGenerations: new Map(),
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    sshConnectedGeneration: 0
  })
)
afterEach(() => {
  unsubs.splice(0).forEach((unsubscribe) => unsubscribe())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function bridgeFixture() {
  const snapshot = Promise.withResolvers<RuntimeOwnedSshAuthority[]>()
  let listener: (authority: RuntimeOwnedSshAuthority) => void = () => {
    throw new Error('Authority listener must register before hydration')
  }
  const unsubscribe = vi.fn()
  vi.stubGlobal('window', {
    api: {
      ssh: {
        onRuntimeOwnedAuthorityChanged: (callback: typeof listener) => {
          listener = callback
          return unsubscribe
        },
        listRuntimeOwnedAuthorities: () => snapshot.promise
      }
    }
  })
  registerRuntimeOwnedSshAuthorityIpcBridge(unsubs)
  return {
    snapshot,
    push: (authority: RuntimeOwnedSshAuthority) => listener(authority),
    unsubscribe
  }
}

it('hydrates only private authority and clears old entries absent from the snapshot', async () => {
  useAppStore.getState().setRuntimeOwnedSshConnectionGeneration('runtime-ssh-old', 1)
  const { snapshot } = bridgeFixture()
  snapshot.resolve([{ targetId, connectionGeneration: 9007199254000001 }])
  await snapshot.promise
  expect([...useAppStore.getState().runtimeOwnedSshConnectionGenerations]).toEqual([
    [targetId, 9007199254000001]
  ])
  expect(useAppStore.getState().sshConnectionStates.size).toBe(0)
  expect(useAppStore.getState().sshTargetLabels.size).toBe(0)
})

it('keeps a newer rotation over a stale hydration reply', async () => {
  const { snapshot, push } = bridgeFixture()
  push({ targetId, connectionGeneration: 8 })
  snapshot.resolve([{ targetId, connectionGeneration: 7 }])
  await snapshot.promise
  expect(useAppStore.getState().runtimeOwnedSshConnectionGenerations.get(targetId)).toBe(8)
})

it('does not resurrect a revoked target from a stale snapshot', async () => {
  const { snapshot, push } = bridgeFixture()
  push({ targetId, connectionGeneration: 8 })
  push({ targetId, connectionGeneration: null })
  snapshot.resolve([{ targetId, connectionGeneration: 7 }])
  await snapshot.promise
  expect(useAppStore.getState().runtimeOwnedSshConnectionGenerations.has(targetId)).toBe(false)
})

it('a recreated bridge clears a revoked target from an empty snapshot without receiving the old push', async () => {
  const first = bridgeFixture()
  first.push({ targetId, connectionGeneration: 8 })
  first.snapshot.resolve([{ targetId, connectionGeneration: 8 }])
  await first.snapshot.promise
  unsubs.splice(0).forEach((dispose) => dispose())
  const fresh = bridgeFixture()
  fresh.snapshot.resolve([])
  await fresh.snapshot.promise
  expect(first.unsubscribe).toHaveBeenCalledOnce()
  expect(useAppStore.getState().runtimeOwnedSshConnectionGenerations.has(targetId)).toBe(false)
})

it('unsubscribes and ignores replies and pushes after bridge disposal', async () => {
  const { snapshot, push, unsubscribe } = bridgeFixture()
  unsubs.splice(0).forEach((dispose) => dispose())
  push({ targetId, connectionGeneration: 8 })
  snapshot.resolve([{ targetId, connectionGeneration: 7 }])
  await snapshot.promise
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(useAppStore.getState().runtimeOwnedSshConnectionGenerations.size).toBe(0)
})

it('does not notify the store twice for the same authority or retain malformed owner rows', () => {
  const store = useAppStore.getState()
  store.setRuntimeOwnedSshConnectionGeneration(targetId, 3)
  const before = useAppStore.getState()
  const changed = vi.fn()
  const unsubscribe = useAppStore.subscribe(changed)
  try {
    store.setRuntimeOwnedSshConnectionGeneration(targetId, 3)
    store.setRuntimeOwnedSshConnectionGeneration('ssh-user', 3)
    store.setRuntimeOwnedSshConnectionGeneration(targetId, -1)
    expect(useAppStore.getState()).toBe(before)
    expect(changed).not.toHaveBeenCalled()
    store.setRuntimeOwnedSshConnectionGeneration(targetId, null)
    expect(useAppStore.getState().runtimeOwnedSshConnectionGenerations.size).toBe(0)
  } finally {
    unsubscribe()
  }
})
