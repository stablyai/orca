import { beforeEach, expect, it, vi } from 'vitest'
import { preparePendingSplitClose } from './pending-split-close-test-fixture'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { LOCAL_LAYOUT_APPLY_ORIGIN } from '@/runtime/server-layout-apply-routes'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: false,
  commitTerminalSurfaceClose: vi.fn(),
  sendLayoutCommandToOwner: vi.fn<typeof sendLayoutCommandToOwner>()
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/layout-owner-command', () => ({
  sendLayoutCommandToOwner: mocks.sendLayoutCommandToOwner
}))
vi.mock('@/store/terminals/terminal-surface-close-intent', () => ({
  commitTerminalSurfaceClose: mocks.commitTerminalSurfaceClose
}))

const LEAF = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  mocks.layoutOwnerIsMain = false
  mocks.commitTerminalSurfaceClose.mockReset()
  mocks.sendLayoutCommandToOwner.mockReset()
  mocks.sendLayoutCommandToOwner.mockReturnValue(true)
})

it('a window-owned build closes the pane at once and reports it to main', async () => {
  const p = await preparePendingSplitClose()

  p.actions.executeClosePane(1)

  expect(mocks.sendLayoutCommandToOwner).not.toHaveBeenCalled()
  expect(mocks.commitTerminalSurfaceClose).toHaveBeenCalledWith('workspace', {
    kind: 'pane',
    tabId: 'tab-parent',
    leafId: LEAF
  })
  expect(p.transports.has(1)).toBe(false)
})

it('a layout-owner build removes the pane only once main’s frame drops it', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  const intents = await import('@/runtime/layout-owner-pane-intents')
  ;(await import('@/runtime/layout-frame-position')).noteLayoutFramePosition(1)

  p.actions.executeClosePane(1)

  expect(mocks.sendLayoutCommandToOwner).toHaveBeenCalledWith(
    'workspace',
    { type: 'closePane', tabId: 'tab-parent', leafId: LEAF },
    {
      apply: expect.any(Function),
      asToday: expect.any(Function),
      refused: expect.any(Function)
    }
  )
  mocks.sendLayoutCommandToOwner.mock.calls[0]?.[2].apply({}, LOCAL_LAYOUT_APPLY_ORIGIN)
  expect(p.transports.has(1)).toBe(true)

  // The frame without the pane finds the window's close and runs it.
  expect(intents.takePaneCloseIntent('tab-parent', LEAF)).toBe('user')
  p.actions.closePaneLocally(1, LEAF)

  expect(p.transports.has(1)).toBe(false)
  expect(mocks.commitTerminalSurfaceClose).not.toHaveBeenCalled()
})

it('a layout-owner build closes the pane itself when main closed it and no frame is coming', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  ;(await import('@/runtime/layout-frame-position')).endLayoutFramePositions()

  p.actions.executeClosePane(1)
  mocks.sendLayoutCommandToOwner.mock.calls[0]?.[2].apply({}, LOCAL_LAYOUT_APPLY_ORIGIN)

  expect(p.transports.has(1)).toBe(false)
  expect(mocks.commitTerminalSurfaceClose).not.toHaveBeenCalled()
})

it('a layout-owner build closes the pane itself when main holds no such pane, so no frame drops it', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  ;(await import('@/runtime/layout-frame-position')).noteLayoutFramePosition(1)

  p.actions.executeClosePane(1)
  mocks.sendLayoutCommandToOwner.mock.calls[0]?.[2].apply(
    { alreadyClosed: true },
    LOCAL_LAYOUT_APPLY_ORIGIN
  )

  const intents = await import('@/runtime/layout-owner-pane-intents')
  expect(intents.takePaneCloseIntent('tab-parent', LEAF)).toBeNull()
  expect(p.transports.has(1)).toBe(false)
  expect(mocks.commitTerminalSurfaceClose).not.toHaveBeenCalled()
})

it('a layout-owner build closes as today, forgetting its close, when main lacks the pane', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()

  p.actions.executeClosePane(1)
  mocks.sendLayoutCommandToOwner.mock.calls[0]?.[2].asToday()

  const intents = await import('@/runtime/layout-owner-pane-intents')
  expect(intents.takePaneCloseIntent('tab-parent', LEAF)).toBeNull()
  expect(mocks.commitTerminalSurfaceClose).toHaveBeenCalledOnce()
  expect(p.transports.has(1)).toBe(false)
})

it('a layout-owner build closes the tab when main refuses a second close as the last pane', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)
  p.actions.executeClosePane(2)
  const [first, second] = mocks.sendLayoutCommandToOwner.mock.calls.map(([, , on]) => on)

  // Main took pane 1; its frame is still on the way when main refuses pane 2 as its last.
  ;(await import('@/runtime/layout-frame-position')).noteLayoutFramePosition(1)
  first?.apply({}, LOCAL_LAYOUT_APPLY_ORIGIN)
  second?.refused?.('last_pane')

  expect(p.controller.onCloseTab).toHaveBeenCalledOnce()
})

it('a layout-owner build leaves an unmounted tab alone when main refuses its last pane', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)
  p.controller.managerRef.current = null

  mocks.sendLayoutCommandToOwner.mock.calls[0]?.[2].refused?.('last_pane')

  expect(p.controller.onCloseTab).not.toHaveBeenCalled()
})

it('a layout-owner build closes as today when main calls it the last pane but the window has more', async () => {
  mocks.layoutOwnerIsMain = true
  const p = await preparePendingSplitClose()
  p.actions.executeClosePane(1)

  mocks.sendLayoutCommandToOwner.mock.calls[0]?.[2].refused?.('last_pane')

  expect(p.controller.onCloseTab).not.toHaveBeenCalled()
  expect(mocks.commitTerminalSurfaceClose).toHaveBeenCalledOnce()
  expect(p.transports.has(1)).toBe(false)
})
