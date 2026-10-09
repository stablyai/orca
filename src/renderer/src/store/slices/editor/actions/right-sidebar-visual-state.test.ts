import { describe, expect, it } from 'vitest'
import {
  createRightSidebarState,
  selectVisibleRightSidebarVisual,
  type RightSidebarState,
  type RightSidebarVisualRoute
} from './right-sidebar-state'
import { rightSidebarVisualWidth } from '../../../../components/right-sidebar/right-sidebar-width'

type Harness = RightSidebarState & { activeWorktreeId: string | null }

function harness(): { state: () => Harness } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: filled by the slice on the next line before any read.
  let state = { activeWorktreeId: 'wt-1' } as Harness
  const set = (update: Partial<Harness> | ((current: Harness) => Partial<Harness>)): void => {
    state = { ...state, ...(typeof update === 'function' ? update(state) : update) }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice only reads and writes the fields this harness holds.
  Object.assign(state, createRightSidebarState(set as never, (() => state) as never))
  return { state: () => state }
}

const route: RightSidebarVisualRoute = {
  target: { kind: 'local' },
  sessionId: 'session-alpha',
  messageId: 'message-1',
  file: 'chart.html',
  title: 'Chart',
  tabId: 'tab-1',
  worktreeId: 'wt-1'
}

describe('right sidebar visual route', () => {
  it('opens the sidebar on the visual and closes it again when it had been closed', () => {
    const { state } = harness()
    expect(state().rightSidebarOpen).toBe(false)
    state().openRightSidebarVisual(route)
    expect(state().rightSidebarOpen).toBe(true)
    expect(selectVisibleRightSidebarVisual(state())).toMatchObject({ file: 'chart.html' })
    state().closeRightSidebarVisual()
    expect(selectVisibleRightSidebarVisual(state())).toBeNull()
    expect(state().rightSidebarOpen).toBe(false)
  })

  it('returns to the open sidebar it replaced', () => {
    const { state } = harness()
    state().setRightSidebarOpen(true)
    state().setRightSidebarTab('source-control')
    state().openRightSidebarVisual(route)
    state().closeRightSidebarVisual()
    expect(state().rightSidebarOpen).toBe(true)
    expect(state().rightSidebarTab).toBe('source-control')
  })

  it('gives way to any tab the user picks, without being cleared explicitly', () => {
    const { state } = harness()
    state().openRightSidebarVisual(route)
    state().setRightSidebarTab('checks')
    expect(selectVisibleRightSidebarVisual(state())).toBeNull()
    expect(state().rightSidebarTab).toBe('checks')
  })

  it('is dropped when the sidebar closes', () => {
    const { state } = harness()
    state().openRightSidebarVisual(route)
    state().toggleRightSidebar()
    expect(state().rightSidebarVisual).toBeNull()
    state().toggleRightSidebar()
    expect(selectVisibleRightSidebarVisual(state())).toBeNull()
  })

  it('widens while shown without touching the stored width, and keeps a resize to itself', () => {
    const { state } = harness()
    state().setRightSidebarWidth(300)
    state().openRightSidebarVisual(route)
    const visual = selectVisibleRightSidebarVisual(state())
    expect(rightSidebarVisualWidth(state().rightSidebarWidth, visual?.width ?? null)).toBe(720)
    state().setRightSidebarVisualWidth(900)
    expect(selectVisibleRightSidebarVisual(state())?.width).toBe(900)
    expect(state().rightSidebarWidth).toBe(300)
    state().closeRightSidebarVisual()
    expect(state().rightSidebarWidth).toBe(300)
  })

  it('keeps a wider stored width and the reopen bookkeeping when switching visuals', () => {
    const { state } = harness()
    state().setRightSidebarWidth(1000)
    state().openRightSidebarVisual(route)
    expect(rightSidebarVisualWidth(1000, null)).toBe(1000)
    state().openRightSidebarVisual({ ...route, file: 'other.html' })
    expect(selectVisibleRightSidebarVisual(state())).toMatchObject({
      file: 'other.html',
      reopenedSidebar: true
    })
  })
})
