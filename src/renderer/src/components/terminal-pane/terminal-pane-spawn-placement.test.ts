// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPanePlacement } from '../../../../shared/terminal-pane-placement'

const TAB = {
  id: 'tab-1',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'Terminal 2',
  defaultTitle: 'Terminal 2',
  customTitle: 'Build',
  color: '#f97316',
  sortOrder: 1,
  createdAt: 42,
  shellOverride: 'wsl.exe',
  isPinned: true
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ tabsByWorktree: { 'wt-1': [TAB] } }) }
}))
// Why: happy-dom has no canvas, so xterm cannot open; placement never touches the terminal.
vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('@/lib/pane-manager/pane-manager')
const { completePaneSpawnPlacement } = await import('./terminal-pane-spawn-placement')

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

describe('completePaneSpawnPlacement', () => {
  const root = document.createElement('div')

  afterEach(() => {
    root.replaceChildren()
  })

  it('adds the tab creation fields to a new tab', () => {
    const placement = completePaneSpawnPlacement(
      { kind: 'new-tab' },
      { worktreeId: 'wt-1', tabId: 'tab-1', container: root }
    )

    expect(placement).toEqual({
      kind: 'new-tab',
      row: {
        title: 'Terminal 2',
        defaultTitle: 'Terminal 2',
        customTitle: 'Build',
        color: '#f97316',
        createdAt: 42,
        shellOverride: 'wsl.exe'
      }
    })
  })

  it('leaves a new tab bare when the store no longer has it', () => {
    expect(
      completePaneSpawnPlacement(
        { kind: 'new-tab' },
        { worktreeId: 'wt-1', tabId: 'tab-gone', container: root }
      )
    ).toEqual({ kind: 'new-tab' })
  })

  it('adds the mounted tree after the split', () => {
    let placement: TerminalPanePlacement | undefined
    const manager = new PaneManager(root, {
      linkOpenHint: () => '',
      onPaneCreated: (_pane, hints) => {
        placement = hints?.placement
          ? completePaneSpawnPlacement(hints.placement, {
              worktreeId: 'wt-1',
              tabId: 'tab-1',
              container: root
            })
          : undefined
      }
    })
    const first = manager.createInitialPane({ leafId: LEAF_A })
    manager.splitPane(first.id, 'horizontal', { leafId: LEAF_B, ratio: 0.3 })

    expect(placement).toEqual({
      kind: 'split',
      parentLeafId: LEAF_A,
      direction: 'horizontal',
      ratio: 0.3,
      proposedRoot: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B },
        ratio: 0.3
      }
    })
    manager.destroy()
  })
})
