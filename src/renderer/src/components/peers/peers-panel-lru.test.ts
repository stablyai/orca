import { describe, expect, it } from 'vitest'
import type { RemoteTerminalTarget } from '../peer-collab/remote-terminal-target'
import { isSameTarget, pruneUngrantedKeepAlive, visitPeersKeepAlive } from './peers-panel-lru'

function target(handle: string): RemoteTerminalTarget {
  return { hostId: 'host-1', handle, title: handle }
}

describe('visitPeersKeepAlive', () => {
  it('moves a revisited target to the front without duplicating it', () => {
    const mounted = [target('a'), target('b'), target('c')]

    const next = visitPeersKeepAlive(mounted, target('b'), [target('b')])

    expect(next.map((t) => t.handle)).toEqual(['b', 'a', 'c'])
  })

  it('evicts the oldest non-pinned target once the cap is exceeded', () => {
    const mounted = [target('a'), target('b'), target('c')]

    const next = visitPeersKeepAlive(mounted, target('d'), [target('d')], 3)

    expect(next.map((t) => t.handle)).toEqual(['d', 'a', 'b'])
  })

  it('never evicts a pinned target even if it is the oldest entry', () => {
    const mounted = [target('primary'), target('a'), target('b')]

    const next = visitPeersKeepAlive(mounted, target('c'), [target('primary'), target('c')], 3)

    expect(next.map((t) => t.handle)).toContain('primary')
    expect(next).toHaveLength(3)
  })
})

describe('pruneUngrantedKeepAlive', () => {
  it('drops targets the grant predicate rejects', () => {
    const mounted = [target('a'), target('b')]

    const next = pruneUngrantedKeepAlive(mounted, (t) => t.handle !== 'b')

    expect(next.map((t) => t.handle)).toEqual(['a'])
  })
})

describe('isSameTarget', () => {
  it('compares by hostId and handle, not title', () => {
    expect(
      isSameTarget(
        { hostId: 'h', handle: 'x', title: 'A' },
        { hostId: 'h', handle: 'x', title: 'B' }
      )
    ).toBe(true)
    expect(isSameTarget(null, null)).toBe(true)
    expect(isSameTarget(target('a'), null)).toBe(false)
  })
})
