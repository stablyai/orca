import { describe, expect, it } from 'vitest'
import { createTerminalTabOwnerIndex } from './terminal-tab-owner-index'

function trackedTab(id: string, onRead: () => void): { id: string } {
  return Object.defineProperty({}, 'id', {
    configurable: true,
    enumerable: true,
    get() {
      onRead()
      return id
    }
  }) as { id: string }
}

describe('terminal tab owner index', () => {
  it('updates added, removed, and moved buckets without inspecting an unchanged bucket', () => {
    const reads = { stable: 0, moving: 0, added: 0, removed: 0 }
    const stableBucket = [
      trackedTab('stable-tab', () => {
        reads.stable += 1
      })
    ]
    const sourceBucket = [
      trackedTab('moving-tab', () => {
        reads.moving += 1
      })
    ]
    const removedBucket = [
      trackedTab('removed-tab', () => {
        reads.removed += 1
      })
    ]
    const index = createTerminalTabOwnerIndex()

    index.getOwners({ stable: stableBucket, source: sourceBucket, removed: removedBucket })
    reads.stable = 0
    reads.moving = 0
    reads.added = 0
    reads.removed = 0

    const owners = index.getOwners({
      stable: stableBucket,
      source: [],
      destination: [
        trackedTab('moving-tab', () => {
          reads.moving += 1
        })
      ],
      added: [
        trackedTab('added-tab', () => {
          reads.added += 1
        })
      ]
    })

    expect(owners.get('stable-tab')).toBe('stable')
    expect(owners.get('moving-tab')).toBe('destination')
    expect(owners.get('added-tab')).toBe('added')
    expect(owners.has('removed-tab')).toBe(false)
    expect(reads).toEqual({ stable: 0, moving: 1, added: 1, removed: 0 })
  })

  it('adopts a warm metadata-only replacement without fleet visits or owner-map allocation', () => {
    let outerKeyVisits = 0
    let bucketVisits = 0
    const observeOuterMap = <T extends Record<string, readonly { id: string }[]>>(value: T): T =>
      new Proxy(value, {
        ownKeys(target) {
          outerKeyVisits += 1
          return Reflect.ownKeys(target)
        },
        get(target, property, receiver) {
          if (typeof property === 'string' && property.startsWith('wt-')) {
            bucketVisits += 1
          }
          return Reflect.get(target, property, receiver)
        }
      })
    const initial = observeOuterMap(
      Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [
          `wt-${index}`,
          [{ id: `tab-${index}`, title: 'Initial title' }]
        ])
      )
    )
    const index = createTerminalTabOwnerIndex()
    const owners = index.getOwners(initial)
    const next = observeOuterMap({
      ...initial,
      'wt-299': [{ id: 'tab-299', title: 'Changed title' }]
    })
    index.adoptMetadataOnlyBucketReplacements(initial, next, ['wt-299'])
    outerKeyVisits = 0
    bucketVisits = 0

    const warmOwners = index.getOwners(next)

    expect(warmOwners).toBe(owners)
    expect(warmOwners.get('tab-299')).toBe('wt-299')
    expect(outerKeyVisits).toBe(0)
    expect(bucketVisits).toBe(0)
  })

  it('replaces the topology on hydration across every workspace key kind', () => {
    const index = createTerminalTabOwnerIndex()
    index.getOwners({ stale: [{ id: 'stale-tab' }] })

    const hydrated = {
      'repo-local::/Users/me/project': [{ id: 'local-tab' }],
      'folder:folder-workspace-id': [{ id: 'folder-tab' }],
      'repo-ssh::/srv/project': [{ id: 'ssh-tab' }],
      'repo-wsl::\\\\wsl.localhost\\Ubuntu\\home\\me\\project': [{ id: 'wsl-tab' }],
      'worktree:repo-runtime::/workspace::workspace:paired-runtime-id': [
        { id: 'paired-runtime-tab' }
      ]
    }
    const owners = index.getOwners(hydrated)

    expect(Object.fromEntries(owners)).toEqual({
      'local-tab': 'repo-local::/Users/me/project',
      'folder-tab': 'folder:folder-workspace-id',
      'ssh-tab': 'repo-ssh::/srv/project',
      'wsl-tab': 'repo-wsl::\\\\wsl.localhost\\Ubuntu\\home\\me\\project',
      'paired-runtime-tab': 'worktree:repo-runtime::/workspace::workspace:paired-runtime-id'
    })
    expect(owners.has('stale-tab')).toBe(false)
  })

  it('preserves last-wins object order for duplicate ids when only outer keys reorder', () => {
    let idReads = 0
    const firstBucket = [
      trackedTab('duplicate-tab', () => {
        idReads += 1
      }),
      trackedTab('duplicate-tab', () => {
        idReads += 1
      })
    ]
    const secondBucket = [
      trackedTab('duplicate-tab', () => {
        idReads += 1
      })
    ]
    const index = createTerminalTabOwnerIndex()

    expect(index.getOwner({ first: firstBucket, second: secondBucket }, 'duplicate-tab')).toBe(
      'second'
    )
    idReads = 0

    expect(index.getOwner({ second: secondBucket, first: firstBucket }, 'duplicate-tab')).toBe(
      'first'
    )
    expect(idReads).toBe(0)
  })
})
