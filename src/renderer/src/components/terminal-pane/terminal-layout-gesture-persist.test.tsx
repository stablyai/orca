// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ terminalLayoutsByTabId: {} }) }
}))
vi.mock('@/runtime/web-runtime-session', () => ({ clearWebRuntimeTerminalBuffer: () => true }))
vi.mock('@/lib/pane-manager/terminal-scrollback-clear', () => ({
  clearTerminalScrollbackAndFollowOutput: vi.fn()
}))

function renderPersistence() {
  const container = document.createElement('div')
  const split = document.createElement('div')
  split.className = 'pane-split'
  container.append(split)
  const panes = [LEFT, RIGHT].map((leafId, index) => {
    const element = document.createElement('div')
    element.className = 'pane'
    element.dataset.paneId = String(index + 1)
    element.dataset.leafId = leafId
    split.append(element)
    return { id: index + 1, leafId, container: element, terminal: {} }
  })
  const push = vi.fn()
  const setTabLayout = vi.fn()
  const controller = {
    clearedScrollbackLeafIdsRef: { current: new Set<string>() },
    chatLeafId: null,
    containerRef: { current: container },
    isChatViewMode: false,
    expandedPaneIdRef: { current: null },
    managerRef: {
      current: {
        getPanes: () => panes,
        getActivePane: () => panes[0],
        getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId]))
      }
    },
    paneCount: 2,
    paneTitles: { 1: 'build' },
    paneTitlesRef: { current: { 1: 'build' } },
    paneTransportsRef: {
      current: new Map(panes.map((pane) => [pane.id, { getPtyId: () => `remote:host:${pane.id}` }]))
    },
    remotePaneLayoutPusherRef: { current: { push } },
    removedTitleLeafIdsRef: { current: new Set<string>() },
    savedLayout: undefined,
    setPaneTitles: vi.fn(),
    setTabLayout,
    tabId: 'tab',
    terminalTab: null,
    worktreeId: 'wt'
  }
  const hook = renderHook(() =>
    useTerminalPaneLayoutPersistence(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every field the persistence hook reads.
      controller as unknown as Parameters<typeof useTerminalPaneLayoutPersistence>[0]
    )
  )
  const pushedIntents = (): unknown[] => push.mock.calls.map(([input]) => input.intent)
  return { hook, push, setTabLayout, pushedIntents, panes }
}

afterEach(cleanup)

describe('terminal layout gesture persist', () => {
  it('saves the same layout for a gesture and an automatic persist and marks only the push', () => {
    const { hook, push, setTabLayout } = renderPersistence()
    setTabLayout.mockClear()
    push.mockClear()

    hook.result.current.persistLayoutSnapshot()
    hook.result.current.persistLayoutSnapshot('gesture')

    const [[, automaticLayout], [, gestureLayout]] = setTabLayout.mock.calls
    expect(gestureLayout).toEqual(automaticLayout)
    expect(gestureLayout).not.toHaveProperty('intent')
    const [[automaticPush], [gesturePush]] = push.mock.calls
    expect(automaticPush.intent).toBeUndefined()
    expect(gesturePush).toEqual({ ...automaticPush, intent: 'gesture' })
  })

  it('leaves mount and scrollback-clear persists unmarked', () => {
    const { hook, pushedIntents, panes } = renderPersistence()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: clear reads only id, leafId and terminal, all present.
    const pane = panes[0] as unknown as Parameters<
      typeof hook.result.current.clearPaneScrollback
    >[0]
    hook.result.current.clearPaneScrollback(pane)

    expect(pushedIntents().length).toBeGreaterThanOrEqual(2)
    expect(pushedIntents().every((intent) => intent === undefined)).toBe(true)
  })

  it('marks user title clears as gestures', () => {
    const { hook, push, pushedIntents } = renderPersistence()
    push.mockClear()

    hook.result.current.handleClearPaneTitleShortcut(1)
    hook.result.current.removePaneTitle(2)

    expect(pushedIntents()).toEqual(['gesture', 'gesture'])
  })
})
