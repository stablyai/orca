import { afterEach, describe, expect, it } from 'vitest'
import { resetHostTwinModuleStores } from '@/store/host-twin-state-projection.test-fixture'
import { createHostTwinFixture, type HostTwinFixture } from '@/store/host-twin.test-fixture'
import { collectTwinHostsAlsoSlept } from './sleep-twin-confirmation'

let current: HostTwinFixture | null = null

afterEach(() => {
  if (current) {
    resetHostTwinModuleStores(current)
  }
  current = null
})

function twin(): HostTwinFixture {
  current = createHostTwinFixture('local+ssh')
  return current
}

const row = (f: HostTwinFixture, side: HostTwinFixture['local']) => ({
  id: f.workspaceKey,
  hostId: side.hostId
})

describe('the twin copies a sleep also reaches', () => {
  it('names the other copy when only one is selected', () => {
    const f = twin()

    expect(collectTwinHostsAlsoSlept(f.store.getState(), [row(f, f.local)])).toEqual([
      f.remote.hostId
    ])
  })

  it('treats an unstamped row as the local copy', () => {
    const f = twin()
    const unstampedLocal = { id: f.workspaceKey }

    expect(collectTwinHostsAlsoSlept(f.store.getState(), [unstampedLocal])).toEqual([
      f.remote.hostId
    ])
    expect(
      collectTwinHostsAlsoSlept(f.store.getState(), [unstampedLocal, row(f, f.remote)])
    ).toEqual([])
  })

  it('names nothing when every copy is selected', () => {
    const f = twin()

    expect(
      collectTwinHostsAlsoSlept(f.store.getState(), [row(f, f.local), row(f, f.remote)])
    ).toEqual([])
  })

  it('names nothing for a workspace only one host publishes', () => {
    const f = twin()
    f.store.setState((s) => ({
      worktreesByRepo: {
        [f.projectId]: (s.worktreesByRepo[f.projectId] ?? []).filter(
          (worktree) => worktree.hostId === f.local.hostId
        )
      }
    }))

    expect(collectTwinHostsAlsoSlept(f.store.getState(), [row(f, f.local)])).toEqual([])
  })
})
