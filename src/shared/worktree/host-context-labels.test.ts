import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../execution-host'
import { getMixedHostContextLabels } from './host-context-labels'

type Item = { id: string; hostId: ExecutionHostId }

function argsFor(counters: { hostIdReads: number; identityReads: number }) {
  return {
    getHostId: (item: Item): ExecutionHostId => {
      counters.hostIdReads += 1
      return item.hostId
    },
    getIdentity: (item: Item): string => {
      counters.identityReads += 1
      return item.id
    }
  }
}

describe('getMixedHostContextLabels', () => {
  it('returns undefined without building any labels when every item shares one host', () => {
    const items: Item[] = Array.from({ length: 50 }, (_, index) => ({
      id: `wt-${index}`,
      hostId: 'local' as ExecutionHostId
    }))
    const counters = { hostIdReads: 0, identityReads: 0 }

    expect(getMixedHostContextLabels(items, argsFor(counters))).toBeUndefined()
    // The label map was built for all 50 and thrown away before; now nothing is built.
    expect(counters.identityReads).toBe(0)
  })

  it('labels every item once a second host appears, wherever it appears', () => {
    for (const lateIndex of [1, 25, 49]) {
      const items: Item[] = Array.from({ length: 50 }, (_, index) => ({
        id: `wt-${index}`,
        hostId: (index === lateIndex ? 'ssh:other' : 'local') as ExecutionHostId
      }))
      const counters = { hostIdReads: 0, identityReads: 0 }

      const labels = getMixedHostContextLabels(items, argsFor(counters))

      expect(labels, `second host at index ${lateIndex}`).toBeDefined()
      expect(labels?.size).toBe(50)
      expect(labels?.has(`wt-${lateIndex}`)).toBe(true)
    }
  })

  it('returns undefined for an empty list', () => {
    const counters = { hostIdReads: 0, identityReads: 0 }
    expect(getMixedHostContextLabels([], argsFor(counters))).toBeUndefined()
  })
})
