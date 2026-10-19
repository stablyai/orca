import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { LayoutApplyHandlers } from '@/runtime/layout-apply-send'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { endLayoutFramePositions, noteLayoutFramePosition } from '@/runtime/layout-frame-position'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  expectPaneToClose,
  takePaneCloseIntent
} from '@/runtime/layout-owner-pane-intents'
import { closeExitedSplitPaneThroughLayoutOwner } from './exited-split-pane-close'

const mocks = vi.hoisted(() => ({
  sendLayoutCommandToOwner: vi.fn<typeof sendLayoutCommandToOwner>()
}))
vi.mock('@/runtime/layout-owner-command', () => ({
  sendLayoutCommandToOwner: mocks.sendLayoutCommandToOwner
}))

const LEAF = '11111111-1111-4111-8111-111111111111'

function fakeManager(paneCount: number) {
  const leaves = new Map<number, string>([[1, LEAF]])
  let panes = paneCount
  const leafIds = (): { leafId: string }[] =>
    Array.from({ length: panes }, (_, index) => ({
      leafId: index === 0 ? LEAF : `sibling-${index}`
    }))
  const closePane = vi.fn((paneId: number) => {
    leaves.delete(paneId)
    panes -= 1
  })
  const manager = {
    getLeafId: (paneId: number) => leaves.get(paneId) ?? null,
    getPanes: leafIds,
    closePane
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close reads only these three members.
    manager: manager as unknown as PaneManager,
    closePane,
    loseSibling: () => {
      panes -= 1
    },
    lose: () => leaves.delete(1)
  }
}

function close(paneCount = 2) {
  const fake = fakeManager(paneCount)
  const closeTab = vi.fn()
  const sent = closeExitedSplitPaneThroughLayoutOwner({
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    manager: fake.manager,
    paneId: 1,
    closeTab
  })
  const handlers = (): LayoutApplyHandlers => mocks.sendLayoutCommandToOwner.mock.calls[0]![2]
  return { ...fake, closeTab, sent, handlers }
}

describe('closeExitedSplitPaneThroughLayoutOwner', () => {
  beforeEach(() => {
    _resetLayoutOwnerPaneIntentsForTests()
    mocks.sendLayoutCommandToOwner.mockReset()
    mocks.sendLayoutCommandToOwner.mockReturnValue(true)
  })

  it('asks main to close the exited pane, leaving its removal to main’s frame', () => {
    const c = close()

    expect(c.sent).toBe(true)
    expect(mocks.sendLayoutCommandToOwner).toHaveBeenCalledWith(
      'wt-1',
      { type: 'closePane', tabId: 'tab-1', leafId: LEAF, automatic: true },
      expect.any(Object)
    )
    noteLayoutFramePosition(1)
    c.handlers().apply({})
    endLayoutFramePositions()

    expect(c.closePane).not.toHaveBeenCalled()
    expect(takePaneCloseIntent('tab-1', LEAF)).toBe('exit')
  })

  it('closes the pane itself when main closed it and no frame is coming', () => {
    const c = close()

    c.handlers().apply({})

    expect(c.closePane).toHaveBeenCalledWith(1)
    expect(takePaneCloseIntent('tab-1', LEAF)).toBeNull()
  })

  it('closes the tab when main calls the pane its last while a sibling’s exit close is pending', () => {
    const c = close()
    expectPaneToClose('tab-1', 'sibling-1', 'exit')

    c.handlers().refused?.('last_pane')

    expect(c.closePane).not.toHaveBeenCalled()
    expect(c.closeTab).toHaveBeenCalledOnce()
  })

  it('closes the tab instead when main refuses the pane as its last and the window agrees', () => {
    const c = close()
    c.loseSibling()

    c.handlers().refused?.('last_pane')

    expect(c.closePane).not.toHaveBeenCalled()
    expect(c.closeTab).toHaveBeenCalledOnce()
    expect(takePaneCloseIntent('tab-1', LEAF)).toBeNull()
  })

  it('does nothing when the pane already went', () => {
    const c = close()
    c.lose()

    c.handlers().asToday()

    expect(c.closePane).not.toHaveBeenCalled()
    expect(c.closeTab).not.toHaveBeenCalled()
  })

  it('closes as today when main lacks the pane or holds it alone', () => {
    const lacking = close()
    lacking.handlers().asToday()
    expect(lacking.closePane).toHaveBeenCalledWith(1)

    mocks.sendLayoutCommandToOwner.mockClear()
    const lagging = close()
    lagging.handlers().refused?.('last_pane')
    expect(lagging.closePane).toHaveBeenCalledWith(1)

    mocks.sendLayoutCommandToOwner.mockClear()
    const other = close()
    other.handlers().refused?.('pane_sleeping')
    expect(other.closePane).not.toHaveBeenCalled()
  })

  it('leaves a paired server’s pane to today’s close', () => {
    mocks.sendLayoutCommandToOwner.mockReturnValue(false)

    expect(close().sent).toBe(false)
  })
})
