import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { layoutOwnerPaneGestures } from './terminal-pane-layout-owner-gestures'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

const mocks = vi.hoisted(() => ({
  root: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.3,
    first: { type: 'leaf', leafId: 'leaf-1' },
    second: { type: 'leaf', leafId: 'leaf-2' }
  },
  send: vi.fn<typeof sendLayoutCommandToOwner>()
}))

vi.mock('@/runtime/layout-owner-command', () => ({
  sendLayoutCommandToOwner: mocks.send
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ terminalLayoutsByTabId: { 'tab-1': { root: mocks.root } } }) }
}))

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
  })

  it('takes an in-tab drop and moves the pane once main has', () => {
    const move = vi.fn()

    const taken = gestures().takePaneDrop?.(
      { sourcePaneId: 2, targetPaneId: 1, zone: 'left' },
      move
    )

    expect(taken).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith(
      'worktree-1',
      { type: 'movePane', tabId: 'tab-1', leafId: 'leaf-2', targetLeafId: 'leaf-1', side: 'left' },
      {
        apply: expect.any(Function),
        asToday: expect.any(Function),
        refused: expect.any(Function)
      }
    )
    expect(move).not.toHaveBeenCalled()

    mocks.send.mock.calls[0]?.[2].apply({})
    expect(move).toHaveBeenCalledOnce()
  })

  it('moves the pane as today when main answers as today', () => {
    const move = vi.fn()
    gestures().takePaneDrop?.({ sourcePaneId: 2, targetPaneId: 1, zone: 'left' }, move)

    mocks.send.mock.calls[0]?.[2].asToday()

    expect(move).toHaveBeenCalledOnce()
  })

  it('keeps the window’s shape when main refuses, as main’s tree did not change', () => {
    const move = vi.fn()
    gestures().takePaneDrop?.({ sourcePaneId: 2, targetPaneId: 1, zone: 'left' }, move)
    mocks.send.mock.calls[0]?.[2]?.refused?.('same_pane')

    expect(move).not.toHaveBeenCalled()
  })

  it('holds divider ratios until every move in flight has settled, even one that threw', () => {
    const view = gestures()
    const failingMove = vi.fn(() => {
      throw new Error('pane gone')
    })
    view.takePaneDrop?.({ sourcePaneId: 2, targetPaneId: 1, zone: 'left' }, failingMove)
    view.takePaneDrop?.({ sourcePaneId: 1, targetPaneId: 2, zone: 'top' }, vi.fn())
    view.onDividerRatiosCommitted?.()
    const [first, second] = mocks.send.mock.calls.map(([, , on]) => on)

    expect(() => first?.apply({})).toThrow('pane gone')
    expect(mocks.send).toHaveBeenCalledTimes(2)

    second?.apply({})
    expect(mocks.send).toHaveBeenCalledTimes(3)
    expect(mocks.send).toHaveBeenLastCalledWith(
      'worktree-1',
      { type: 'setPaneRatios', tabId: 'tab-1', root: mocks.root },
      { apply: expect.any(Function), asToday: expect.any(Function) }
    )
  })

  it('holds divider ratios sent during a move until the window has moved too', () => {
    const view = gestures()
    const move = vi.fn()
    view.takePaneDrop?.({ sourcePaneId: 2, targetPaneId: 1, zone: 'left' }, move)

    view.onDividerRatiosCommitted?.()
    expect(mocks.send).toHaveBeenCalledOnce()

    mocks.send.mock.calls[0]?.[2].apply({})
    expect(move).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenLastCalledWith(
      'worktree-1',
      { type: 'setPaneRatios', tabId: 'tab-1', root: mocks.root },
      { apply: expect.any(Function), asToday: expect.any(Function) }
    )
  })

  it('leaves the drop to the window when main cannot take it', () => {
    const drop = { sourcePaneId: 2, targetPaneId: 1, zone: 'left' } as const

    expect(gestures().takePaneDrop?.({ ...drop, sourcePaneId: 0 }, vi.fn())).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()

    mocks.send.mockReturnValue(false)
    expect(gestures().takePaneDrop?.(drop, vi.fn())).toBe(false)
  })

  it('sends the tab’s new ratios to main when a divider drag ends', () => {
    gestures().onDividerRatiosCommitted?.()

    expect(mocks.send).toHaveBeenCalledWith(
      'worktree-1',
      { type: 'setPaneRatios', tabId: 'tab-1', root: mocks.root },
      { apply: expect.any(Function), asToday: expect.any(Function) }
    )
  })

  it('sends no ratios while a restore owns the layout', () => {
    gestures(false).onDividerRatiosCommitted?.()

    expect(mocks.send).not.toHaveBeenCalled()
  })
})
