import { describe, expect, it } from 'vitest'
import { collectWslMoveSleptPaneBindings } from './wsl-move-slept-pane-bindings'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function layout(ptyIdsByLeafId: Record<string, string>) {
  return {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: LEAF_A },
      second: { type: 'leaf' as const, leafId: LEAF_B }
    },
    activeLeafId: LEAF_A,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

describe('collectWslMoveSleptPaneBindings', () => {
  it('reports bound panes with no live terminal, never a live one', () => {
    const tab = { id: 'tab-1', ptyId: 'w@@slept', worktreeId: 'w' }
    const state = {
      tabsByWorktree: { w: [tab] },
      terminalLayoutsByTabId: { 'tab-1': layout({ [LEAF_A]: 'w@@slept', [LEAF_B]: 'w@@live' }) },
      ptyIdsByTabId: { 'tab-1': ['w@@live'] }
    }
    const bindings = collectWslMoveSleptPaneBindings(state)
    expect(bindings).toEqual([{ paneKey: `tab-1:${LEAF_A}`, sessionId: 'w@@slept' }])
  })
})
