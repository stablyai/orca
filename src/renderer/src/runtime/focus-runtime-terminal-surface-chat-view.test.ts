// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusRuntimeTerminalSurface, registerRuntimeTerminalTab } from './sync-runtime-graph'

const TAB_ID = 'chat-view-tab'
const WORKTREE_ID = 'chat-view-worktree'
const LEAF_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SECOND_LEAF_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PANE_ID = 1
const SECOND_PANE_ID = 2

const unregisterCallbacks: (() => void)[] = []

/** The cover class TerminalPaneNativeChatPortal renders over the still-mounted xterm. */
function makePaneContainer(covered: boolean, leafId = LEAF_ID): HTMLElement {
  const container = document.createElement('div')
  container.setAttribute('data-leaf-id', leafId)
  if (covered) {
    const shell = document.createElement('div')
    shell.className = 'native-chat-pane-shell absolute inset-0 z-10 flex'
    container.append(shell)
  }
  return container
}

function registerSplitChatViewTab(options: { activeCovered: boolean; requestedCovered: boolean }): {
  setActivePane: ReturnType<typeof vi.fn>
} {
  const panes = [
    {
      id: PANE_ID,
      leafId: LEAF_ID,
      container: makePaneContainer(options.activeCovered),
      terminal: { focus: vi.fn() }
    },
    {
      id: SECOND_PANE_ID,
      leafId: SECOND_LEAF_ID,
      container: makePaneContainer(options.requestedCovered, SECOND_LEAF_ID),
      terminal: { focus: vi.fn() }
    }
  ]
  const setActivePane = vi.fn()
  const manager = {
    getPanes: () => panes,
    getActivePane: () => panes[0],
    getLeafId: (paneId: number) => panes.find((pane) => pane.id === paneId)?.leafId ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      panes.find((pane) => pane.leafId === leafId)?.id ?? null,
    setActivePane
  }
  unregisterCallbacks.push(
    registerRuntimeTerminalTab({
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      getManager: () => manager as never,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
  )
  return { setActivePane }
}

function registerChatViewTab(covered: boolean): {
  focus: ReturnType<typeof vi.fn>
  setActivePane: ReturnType<typeof vi.fn>
} {
  const focus = vi.fn()
  const setActivePane = vi.fn()
  const pane = {
    id: PANE_ID,
    leafId: LEAF_ID,
    container: makePaneContainer(covered),
    terminal: { focus }
  }
  const manager = {
    getPanes: () => [pane],
    getActivePane: () => pane,
    getLeafId: (paneId: number) => (paneId === pane.id ? pane.leafId : null),
    getNumericIdForLeaf: (candidateLeafId: string) =>
      candidateLeafId === pane.leafId ? pane.id : null,
    setActivePane
  }
  unregisterCallbacks.push(
    registerRuntimeTerminalTab({
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      getManager: () => manager as never,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
  )
  return { focus, setActivePane }
}

// Why: a legacy native chat is a terminal tab with viewMode 'chat' — the xterm stays mounted
// under the chat portal, so focusing it drags the caret out of the composer (#9939 twin).
describe('focusRuntimeTerminalSurface on a chat-view pane', () => {
  afterEach(() => {
    while (unregisterCallbacks.length > 0) {
      unregisterCallbacks.pop()?.()
    }
  })

  it('claims focus without touching the covered xterm', () => {
    const { focus } = registerChatViewTab(true)

    // Why true, not false: false routes the caller to the DOM fallback, which for a structured
    // tab id finds no [data-terminal-tab-id] element and focuses an unrelated tab's xterm.
    expect(focusRuntimeTerminalSurface(TAB_ID, null, WORKTREE_ID)).toBe(true)
    expect(focus).not.toHaveBeenCalled()
  })

  it('focuses the active xterm when no chat portal covers it', () => {
    const { focus } = registerChatViewTab(false)

    expect(focusRuntimeTerminalSurface(TAB_ID, null, WORKTREE_ID)).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
  })

  it('activates the requested chat leaf without focusing its covered xterm', () => {
    const { setActivePane } = registerChatViewTab(true)

    expect(focusRuntimeTerminalSurface(TAB_ID, LEAF_ID, WORKTREE_ID)).toBe(true)
    expect(setActivePane).toHaveBeenCalledWith(PANE_ID, { focus: false })
  })

  it('activates the requested leaf with focus when no chat portal covers it', () => {
    const { setActivePane } = registerChatViewTab(false)

    expect(focusRuntimeTerminalSurface(TAB_ID, LEAF_ID, WORKTREE_ID)).toBe(true)
    expect(setActivePane).toHaveBeenCalledWith(PANE_ID, { focus: true })
  })

  it('focuses a requested uncovered leaf when the active leaf is covered', () => {
    const { setActivePane } = registerSplitChatViewTab({
      activeCovered: true,
      requestedCovered: false
    })

    expect(focusRuntimeTerminalSurface(TAB_ID, SECOND_LEAF_ID, WORKTREE_ID)).toBe(true)
    expect(setActivePane).toHaveBeenCalledWith(SECOND_PANE_ID, { focus: true })
  })

  it('activates a requested covered leaf without focusing its xterm', () => {
    const { setActivePane } = registerSplitChatViewTab({
      activeCovered: false,
      requestedCovered: true
    })

    expect(focusRuntimeTerminalSurface(TAB_ID, SECOND_LEAF_ID, WORKTREE_ID)).toBe(true)
    expect(setActivePane).toHaveBeenCalledWith(SECOND_PANE_ID, { focus: false })
  })
})
