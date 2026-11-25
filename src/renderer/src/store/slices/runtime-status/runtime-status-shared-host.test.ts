import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { RuntimeHostStatusSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'

let sequence = 1_000
const snapshot = (patch: Partial<RuntimeHostStatusSnapshot>): RuntimeHostStatusSnapshot => ({
  environmentId: 'shared-env',
  pairingRevision: 0,
  sequence: sequence++,
  checkedAt: 1_700_000_000_000,
  status: {
    runtimeId: 'owner-runtime',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  },
  verification: 'verified',
  transport: 'ready',
  ...patch
})
const stateOf = (environmentId: string) =>
  runtimeHostConnectionStateForEntry(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  )

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

// The outage banner shows for 'reconnecting'; a shared host's chat pane reads the same entry.
describe('a host shared with this account, in no paired catalog', () => {
  it('reads connected from main’s snapshot, as a paired server does, and keeps it across catalog reads', () => {
    useAppStore.getState().setRuntimeEnvironments([])
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot({ sharedHost: true }))
    expect(stateOf('shared-env')).toBe('connected')
    useAppStore.getState().setRuntimeEnvironments([])
    expect(stateOf('shared-env')).toBe('connected')
  })

  it('still drops a snapshot for an unlisted host that is not shared', () => {
    useAppStore.getState().setRuntimeEnvironments([])
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot({ environmentId: 'gone-env' }))
    expect(useAppStore.getState().runtimeStatusByEnvironmentId.has('gone-env')).toBe(false)
  })
})
