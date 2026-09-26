import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { retainLocalScrollbackInRemoteLayout } from './remote-layout-scrollback-retention'

const LEAF_A = 'leaf-a'
const LEAF_B = 'leaf-b'

function layout(overrides: Partial<TerminalLayoutSnapshot> = {}): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_A },
    activeLeafId: LEAF_A,
    expandedLeafId: null,
    ...overrides
  }
}

const SPLIT_ROOT: TerminalLayoutSnapshot['root'] = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: LEAF_A },
  second: { type: 'leaf', leafId: LEAF_B }
}

describe('retainLocalScrollbackInRemoteLayout', () => {
  it('keeps a parked tab scrollback the host copy never had', () => {
    const local = layout({ buffersByLeafId: { [LEAF_A]: 'parked-scrollback' } })

    const merged = retainLocalScrollbackInRemoteLayout(local, layout())

    expect(merged.buffersByLeafId).toEqual({ [LEAF_A]: 'parked-scrollback' })
  })

  it('takes the host structure verbatim when the host added a split while we were away', () => {
    const local = layout({ buffersByLeafId: { [LEAF_A]: 'parked-scrollback' } })
    const remote = layout({ root: SPLIT_ROOT, ptyIdsByLeafId: { [LEAF_B]: 'remote:env/pty-b' } })

    const merged = retainLocalScrollbackInRemoteLayout(local, remote)

    expect(merged.root).toBe(SPLIT_ROOT)
    expect(merged.ptyIdsByLeafId).toEqual({ [LEAF_B]: 'remote:env/pty-b' })
    // The shared leaf keeps its bytes; nothing is invented for the leaf the host just added.
    expect(merged.buffersByLeafId).toEqual({ [LEAF_A]: 'parked-scrollback' })
  })

  it('drops scrollback for a leaf the host retired', () => {
    const local = layout({
      root: SPLIT_ROOT,
      buffersByLeafId: { [LEAF_A]: 'kept', [LEAF_B]: 'retired-pane' }
    })

    const merged = retainLocalScrollbackInRemoteLayout(local, layout())

    expect(merged.buffersByLeafId).toEqual({ [LEAF_A]: 'kept' })
  })

  it('prefers the local copy when both sides hold bytes for one leaf', () => {
    const local = layout({ buffersByLeafId: { [LEAF_A]: 'captured-since-last-upload' } })
    const remote = layout({ buffersByLeafId: { [LEAF_A]: 'older-upload' } })

    const merged = retainLocalScrollbackInRemoteLayout(local, remote)

    expect(merged.buffersByLeafId).toEqual({ [LEAF_A]: 'captured-since-last-upload' })
  })

  it('carries scrollback refs, which name client-local snapshot files only this client can read', () => {
    const local = layout({ scrollbackRefsByLeafId: { [LEAF_A]: 'v1-abc' } })

    const merged = retainLocalScrollbackInRemoteLayout(local, layout())

    expect(merged.scrollbackRefsByLeafId).toEqual({ [LEAF_A]: 'v1-abc' })
  })

  it('returns the host layout untouched when this client holds no scrollback', () => {
    const remote = layout({ buffersByLeafId: { [LEAF_A]: 'from-another-client' } })

    expect(retainLocalScrollbackInRemoteLayout(layout(), remote)).toBe(remote)
    expect(retainLocalScrollbackInRemoteLayout(undefined, remote)).toBe(remote)
  })

  it('leaves a rootless host layout alone rather than guessing which leaves are live', () => {
    const local = layout({ buffersByLeafId: { [LEAF_A]: 'parked-scrollback' } })
    const remote = layout({ root: null })

    expect(retainLocalScrollbackInRemoteLayout(local, remote)).toBe(remote)
  })
})
