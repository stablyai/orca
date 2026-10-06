import { afterEach, describe, expect, it, vi } from 'vitest'
import { SET_TERMINAL_PANE_TITLE_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_ID = '22222222-2222-4222-8222-222222222222'

function createHarness() {
  const listeners = new Map<string, (event: Event) => void>()
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type)
  })
  const panes = [
    { id: 7, leafId: LEAF_ID },
    { id: 8, leafId: SIBLING_ID }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: title events only read the two identity methods; other mount event listeners are not invoked.
  const manager = {
    getNumericIdForLeaf: (id: string) => (id === LEAF_ID ? 7 : id === SIBLING_ID ? 8 : null),
    getPanes: () => panes
  } as unknown as PaneManager
  const setPaneTitle = vi.fn()
  const uninstall = installTerminalPaneMountEvents({
    manager,
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      managerRef: { current: manager },
      setPaneTitle,
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: title and listener cleanup never use PTY connection dependencies.
    ptyDeps: {} as PtyConnectionDeps
  })
  const dispatch = (tabId: string, leafId: string, title: string | null) =>
    listeners.get(SET_TERMINAL_PANE_TITLE_EVENT)?.(
      new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail: { tabId, leafId, title } })
    )
  return { panes, setPaneTitle, dispatch, uninstall, listeners }
}

afterEach(() => vi.unstubAllGlobals())

describe('pane title event identity', () => {
  it('routes set and clear to the GUI setter for the addressed leaf only', () => {
    const { dispatch, setPaneTitle } = createHarness()
    dispatch('tab-1', LEAF_ID, 'REVIEWER')
    dispatch('tab-1', LEAF_ID, null)
    expect(setPaneTitle.mock.calls).toEqual([
      [7, 'REVIEWER'],
      [7, null]
    ])
  })

  it('rejects a stale leaf after the numeric pane id is reused, and another tab', () => {
    const { dispatch, setPaneTitle, panes } = createHarness()
    panes[0].leafId = SIBLING_ID
    dispatch('tab-1', LEAF_ID, 'WRONG')
    dispatch('other-tab', SIBLING_ID, 'WRONG')
    dispatch('tab-1', 'pane:7', 'WRONG')
    expect(setPaneTitle).not.toHaveBeenCalled()
  })

  it('removes its subscription on teardown', () => {
    const { uninstall, listeners } = createHarness()
    expect(listeners.has(SET_TERMINAL_PANE_TITLE_EVENT)).toBe(true)
    uninstall()
    expect(listeners.has(SET_TERMINAL_PANE_TITLE_EVENT)).toBe(false)
  })
})
