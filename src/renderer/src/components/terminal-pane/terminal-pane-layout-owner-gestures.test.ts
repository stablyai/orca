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
  const ratiosSent = () =>
    mocks.send.mock.calls
      .map(([, command]) => command)
      .filter((command) => command.type === 'setPaneRatios')

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
})
