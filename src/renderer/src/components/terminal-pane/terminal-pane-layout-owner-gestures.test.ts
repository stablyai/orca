import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { layoutOwnerPaneGestures } from './terminal-pane-layout-owner-gestures'
import { withPaneSplitRatios } from '../../../../shared/workspace-layout/split-ratio-intents'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

const mocks = vi.hoisted(
  (): {
    root: Extract<TerminalPaneLayoutNode, { type: 'split' }>
    mainRoot: TerminalPaneLayoutNode | undefined
    send: ReturnType<typeof vi.fn<typeof sendLayoutCommandToOwner>>
  } => ({
    root: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.3,
      first: { type: 'leaf', leafId: 'leaf-1' },
      second: { type: 'leaf', leafId: 'leaf-2' }
    },
    mainRoot: undefined,
    send: vi.fn<typeof sendLayoutCommandToOwner>()
  })
)

vi.mock('@/runtime/layout-owner-command', () => ({
  sendLayoutCommandToOwner: mocks.send
}))
vi.mock('@/runtime/layout-frame-terminal-panes', () => ({
  layoutFrameTerminalTab: (worktreeId: string, tabId: string) =>
    worktreeId === 'worktree-1' && tabId === 'tab-1' && mocks.mainRoot
      ? { terminal: { root: mocks.mainRoot } }
      : undefined
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ terminalLayoutsByTabId: { 'tab-1': { root: mocks.root } } }) }
}))

/** The root split's identity: main applies a ratio only to the split it names. */
const ROOT_SPLIT = { direction: 'vertical', first: 'leaf-1', second: 'leaf-2' }

function gestures(shouldPersistLayout = true) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gestures read only getLeafId.
  const manager = {
    getLeafId: (paneId: number) => (paneId > 0 ? `leaf-${paneId}` : null)
  } as unknown as PaneManager
  return layoutOwnerPaneGestures({
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    managerRef: { current: manager },
    shouldPersistLayout: () => shouldPersistLayout
  })
}

describe('layoutOwnerPaneGestures', () => {
  beforeEach(() => {
    mocks.send.mockReset()
    mocks.send.mockReturnValue(true)
    mocks.mainRoot = undefined
  })

  const drop = { sourcePaneId: 2, targetPaneId: 1, zone: 'left' } as const
  const ratiosSent = () =>
    mocks.send.mock.calls
      .map(([, command]) => command)
      .filter((command) => command.type === 'setPaneRatios')

  it('takes an in-tab drop and leaves moving the pane to main’s frame', () => {
    const move = vi.fn()

    expect(gestures().takePaneDrop?.(drop, move)).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith(
      'worktree-1',
      { type: 'movePane', tabId: 'tab-1', leafId: 'leaf-2', targetLeafId: 'leaf-1', side: 'left' },
      {
        apply: expect.any(Function),
        asToday: expect.any(Function),
        refused: expect.any(Function)
      }
    )
    mocks.send.mock.calls[0]?.[2].apply({})

    expect(move).not.toHaveBeenCalled()
  })

  it('moves the pane as today when main answers as today', () => {
    const move = vi.fn()
    gestures().takePaneDrop?.(drop, move)

    mocks.send.mock.calls[0]?.[2].asToday()

    expect(move).toHaveBeenCalledOnce()
  })

  it('keeps the window’s shape when main refuses, as main’s tree did not change', () => {
    const move = vi.fn()
    gestures().takePaneDrop?.(drop, move)
    mocks.send.mock.calls[0]?.[2]?.refused?.('same_pane')

    expect(move).not.toHaveBeenCalled()
  })

  it('leaves the drop to the window when main cannot take it', () => {
    expect(gestures().takePaneDrop?.({ ...drop, sourcePaneId: 0 }, vi.fn())).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()

    mocks.send.mockReturnValue(false)
    expect(gestures().takePaneDrop?.(drop, vi.fn())).toBe(false)
  })

  it('sends the divider that moved, by its path, when a drag ends', () => {
    mocks.mainRoot = { ...mocks.root, ratio: 0.5 }

    gestures().onDividerRatiosCommitted?.()

    expect(mocks.send).toHaveBeenCalledWith(
      'worktree-1',
      {
        type: 'setPaneRatios',
        tabId: 'tab-1',
        ratios: [{ path: '', ratio: 0.3, split: ROOT_SPLIT }]
      },
      {
        apply: expect.any(Function),
        asToday: expect.any(Function),
        refused: expect.any(Function)
      }
    )
  })

  it('sends only the moved divider of a nested split, never the tree', () => {
    const nested = (outer: number, inner: number): typeof mocks.root => ({
      type: 'split',
      direction: 'horizontal',
      ratio: outer,
      first: { type: 'leaf', leafId: 'leaf-1' },
      second: { ...mocks.root, ratio: inner }
    })
    mocks.mainRoot = nested(0.4, 0.5)
    const windowRoot = mocks.root
    mocks.root = nested(0.4, 0.7)
    try {
      gestures().onDividerRatiosCommitted?.()
    } finally {
      mocks.root = windowRoot
    }

    expect(ratiosSent()).toEqual([
      {
        type: 'setPaneRatios',
        tabId: 'tab-1',
        ratios: [{ path: 'second', ratio: 0.7, split: ROOT_SPLIT }]
      }
    ])
  })

  it('sends every divider before main’s frame holds the tab', () => {
    gestures().onDividerRatiosCommitted?.()

    expect(ratiosSent()).toEqual([
      {
        type: 'setPaneRatios',
        tabId: 'tab-1',
        ratios: [{ path: '', ratio: 0.3, split: ROOT_SPLIT }]
      }
    ])
  })

  it('sends ratios at once while a move is in flight, as intents main applies to its own tree', () => {
    mocks.mainRoot = { ...mocks.root, ratio: 0.5 }
    const view = gestures()
    view.takePaneDrop?.(drop, vi.fn())

    view.onDividerRatiosCommitted?.()

    expect(ratiosSent()).toEqual([
      {
        type: 'setPaneRatios',
        tabId: 'tab-1',
        ratios: [{ path: '', ratio: 0.3, split: ROOT_SPLIT }]
      }
    ])
  })

  it('sends nothing once main’s panes moved on; its frame redraws them', () => {
    mocks.mainRoot = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-2' },
      second: { type: 'leaf', leafId: 'leaf-1' }
    }

    gestures().onDividerRatiosCommitted?.()

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('sends a drag back to main’s ratio while the first drag is unanswered, so main ends there', () => {
    const even = { ...mocks.root, ratio: undefined }
    mocks.mainRoot = even
    const view = gestures()
    view.onDividerRatiosCommitted?.()
    const windowRoot = mocks.root
    mocks.root = even
    try {
      view.onDividerRatiosCommitted?.()
    } finally {
      mocks.root = windowRoot
    }

    const sent = ratiosSent().map((command) =>
      command.type === 'setPaneRatios' ? command.ratios : undefined
    )
    expect(sent).toEqual([
      [{ path: '', ratio: 0.3, split: ROOT_SPLIT }],
      [{ path: '', ratio: 0.5, split: ROOT_SPLIT }]
    ])
    // Main applies them in order and ends at the user's last ratio.
    const ended = sent.reduce<TerminalPaneLayoutNode | null>(
      (root, ratios) => root && withPaneSplitRatios(root, ratios ?? []),
      even
    )
    expect(ended).toEqual({ ...even, ratio: undefined })
    expect(ended).not.toHaveProperty('ratio')
  })

  it('sends nothing when no divider moved', () => {
    mocks.mainRoot = mocks.root

    gestures().onDividerRatiosCommitted?.()

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('sends no ratios while a restore owns the layout', () => {
    gestures(false).onDividerRatiosCommitted?.()

    expect(mocks.send).not.toHaveBeenCalled()
  })
})
