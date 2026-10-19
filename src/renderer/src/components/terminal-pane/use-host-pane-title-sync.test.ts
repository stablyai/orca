import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { hostPaneTitleUpdates } from './use-host-pane-title-sync'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_ID = '22222222-2222-4222-8222-222222222222'
const PANES = [
  { id: 1, leafId: LEAF_ID },
  { id: 2, leafId: SIBLING_ID }
]

function hostLayout(
  titlesByLeafId?: Record<string, string>,
  ptyId = toRemoteRuntimePtyId('host-pty', 'env-1')
): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: LEAF_ID },
      second: { type: 'leaf', leafId: SIBLING_ID }
    },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId },
    ...(titlesByLeafId ? { titlesByLeafId } : {})
  }
}

describe('open panes following host pane names (#30386)', () => {
  it('picks up a name the host set, and one it cleared', () => {
    const updates = hostPaneTitleUpdates({
      layout: hostLayout({ [LEAF_ID]: 'server' }),
      panes: PANES,
      shownTitles: { 2: 'old' }
    })
    expect([...updates]).toEqual([
      [1, 'server'],
      [2, null]
    ])
  })

  it('changes nothing once the pane already shows the host name', () => {
    const updates = hostPaneTitleUpdates({
      layout: hostLayout({ [LEAF_ID]: 'server' }),
      panes: PANES,
      shownTitles: { 1: 'server' }
    })
    expect(updates.size).toBe(0)
  })

  it('leaves a local tab alone, since its window owns it', () => {
    const updates = hostPaneTitleUpdates({
      layout: hostLayout({ [LEAF_ID]: 'server' }, 'local-pty'),
      panes: PANES,
      shownTitles: {}
    })
    expect(updates.size).toBe(0)
  })

  it('ignores a pane the host layout does not hold yet', () => {
    const updates = hostPaneTitleUpdates({
      layout: hostLayout(),
      panes: [...PANES, { id: 3, leafId: '33333333-3333-4333-8333-333333333333' }],
      shownTitles: { 3: 'fresh split' }
    })
    expect(updates.size).toBe(0)
  })
})
