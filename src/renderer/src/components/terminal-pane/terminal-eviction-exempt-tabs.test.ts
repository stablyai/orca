import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ terminalLayoutsByTabId: {}, runtimePaneTitlesByTabId: {} }) }
}))

import { selectEvictionExemptTerminalTabLayoutKey } from './terminal-eviction-exempt-tabs'

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PTY_ID = 'repo::/worktree@@session-1'
const TABS = [{ id: TAB_ID, ptyId: PTY_ID }]

function layoutState(ptyIdsByLeafId: Record<string, string>) {
  return { terminalLayoutsByTabId: { [TAB_ID]: { ptyIdsByLeafId } } }
}

describe('selectEvictionExemptTerminalTabLayoutKey', () => {
  // Why: the exempt memo is keyed on the tabs array, which a split leaves
  // untouched — a key blind to layout PTYs would unmount the new live pane.
  it('changes when a split adds a leaf pty', () => {
    const single = layoutState({ [LEAF_ID]: PTY_ID })
    expect(selectEvictionExemptTerminalTabLayoutKey(single, TABS)).toBe(
      selectEvictionExemptTerminalTabLayoutKey(single, TABS)
    )
    expect(
      selectEvictionExemptTerminalTabLayoutKey(
        layoutState({ [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: 'pty-local-detached' }),
        TABS
      )
    ).not.toBe(selectEvictionExemptTerminalTabLayoutKey(single, TABS))
  })

  it('changes when a leaf pty is re-minted under the same layout', () => {
    expect(
      selectEvictionExemptTerminalTabLayoutKey(
        layoutState({ [LEAF_ID]: 'pty-local-detached' }),
        TABS
      )
    ).not.toBe(selectEvictionExemptTerminalTabLayoutKey(layoutState({ [LEAF_ID]: PTY_ID }), TABS))
  })

  it('tolerates tabs with no persisted layout', () => {
    expect(selectEvictionExemptTerminalTabLayoutKey({ terminalLayoutsByTabId: {} }, TABS)).toBe(
      `${TAB_ID}=`
    )
  })
})
