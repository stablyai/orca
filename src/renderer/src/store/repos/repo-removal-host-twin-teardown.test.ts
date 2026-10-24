import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../slices/store-test-helpers'
import { closeRemovedHostTwinState, type RemovedHostTwins } from './repo-removal-host-twin-teardown'

const cancel = vi.hoisted(() =>
  vi.fn((_worktreeIds: ReadonlySet<string>, _ownedByHost?: unknown) => new Set<string>())
)
vi.mock('../slices/worktrees/teardown/purged-structured-launch-retirement', () => ({
  cancelStructuredLaunchesForWorktrees: cancel
}))

const emptyState = () => ({
  terminalTabIds: new Set<string>(),
  fileIds: new Set<string>(),
  browserTabIds: new Set<string>(),
  otherTabIds: new Set<string>(),
  conversationIds: new Set<string>(),
  mixedTabPtyIds: new Set<string>()
})

describe('closeRemovedHostTwinState', () => {
  it('cancels launches only under each attributed host’s own twin ids', () => {
    const store = createTestStore()
    // A is the runtime copy's twin with an SSH survivor; B is attributed to that SSH host.
    const twins: RemovedHostTwins = {
      twinHostIds: new Map([
        ['repo::/a', ['ssh:target']],
        ['repo::/b', ['local']]
      ]),
      byHost: [
        {
          hostId: 'runtime:env',
          twinHostIds: new Map([['repo::/a', ['ssh:target']]]),
          removed: emptyState()
        },
        {
          hostId: 'ssh:target',
          twinHostIds: new Map([['repo::/b', ['local']]]),
          removed: emptyState()
        }
      ]
    }

    closeRemovedHostTwinState(store.getState, store.setState, twins, { ...twins, byHost: [] })

    expect(cancel.mock.calls.map(([ids]) => [...ids])).toEqual([['repo::/a'], ['repo::/b']])
  })
})
