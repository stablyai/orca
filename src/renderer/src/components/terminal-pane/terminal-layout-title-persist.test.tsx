// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { LOCAL_LAYOUT_APPLY_ORIGIN } from '@/runtime/server-layout-apply-routes'

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: false,
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
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ terminalLayoutsByTabId: {} }) }
}))
vi.mock('@/runtime/web-runtime-terminal-buffer-actions', () => ({
  clearWebRuntimeTerminalBuffer: () => true
}))
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
  return { hook, push, setTabLayout }
}

afterEach(() => {
  cleanup()
  mocks.layoutOwnerIsMain = false
  mocks.sendLayoutCommandToOwner.mockReset()
})

describe('terminal layout title persist', () => {
  it('pushes the cleared layout when the clear-title shortcut runs', () => {
    const { hook, push } = renderPersistence()
    push.mockClear()

    hook.result.current.handleClearPaneTitleShortcut(1)

    expect(push).toHaveBeenCalledOnce()
    expect(push.mock.lastCall?.[0].layout.titlesByLeafId).toEqual({})
  })

  it('tells the host to drop every title once the last remote pane title is cleared', () => {
    const { hook, push } = renderPersistence()
    hook.result.current.changePaneTitle(2, 'server')
    expect(push.mock.lastCall?.[0].layout.titlesByLeafId).toEqual({
      [LEFT]: 'build',
      [RIGHT]: 'server'
    })

    hook.result.current.removePaneTitle(2)
    expect(push.mock.lastCall?.[0].layout.titlesByLeafId).toEqual({ [LEFT]: 'build' })

    // An absent field means "unchanged" to every host, so the last clear must say {}.
    hook.result.current.removePaneTitle(1)
    expect(push.mock.lastCall?.[0].layout.titlesByLeafId).toEqual({})
  })

  it('a window-owned build saves a renamed pane at once, without asking main', () => {
    const { hook, push } = renderPersistence()
    push.mockClear()

    hook.result.current.changePaneTitle(2, 'server')

    expect(mocks.sendLayoutCommandToOwner).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledOnce()
  })

  it('a layout-owner build sends a title change to main, whose frame draws it', () => {
    mocks.layoutOwnerIsMain = true
    mocks.sendLayoutCommandToOwner.mockReturnValue(true)
    const { hook, push } = renderPersistence()
    push.mockClear()

    hook.result.current.changePaneTitle(2, 'server')
    hook.result.current.removePaneTitle(1)

    expect(mocks.sendLayoutCommandToOwner.mock.calls.map(([, command]) => command)).toEqual([
      { type: 'renamePane', tabId: 'tab', leafId: RIGHT, title: 'server' },
      { type: 'renamePane', tabId: 'tab', leafId: LEFT, title: null }
    ])
    expect(push).not.toHaveBeenCalled()

    for (const [, , handlers] of mocks.sendLayoutCommandToOwner.mock.calls) {
      handlers.apply({}, LOCAL_LAYOUT_APPLY_ORIGIN)
    }
    // The pane follows the layout's titles main's frame writes (use-host-pane-title-sync.ts).
    expect(push).not.toHaveBeenCalled()
  })
})

describe('terminal layout persist with host-retired panes', () => {
  it('keeps a host-retired pane out of the layout it writes while that pane is still mounted', () => {
    const { hook, push, setTabLayout } = renderPersistence()
    hook.result.current.hostRetiredLeafIdsRef.current = new Set([RIGHT])

    hook.result.current.changePaneTitle(1, 'build')

    const written = setTabLayout.mock.lastCall?.[1]
    expect(written?.root).toEqual({ type: 'leaf', leafId: LEFT })
    expect(written?.activeLeafId).toBe(LEFT)
    expect(written?.ptyIdsByLeafId).toEqual({ [LEFT]: 'remote:host:1' })
    expect(push.mock.lastCall?.[0].layout.root).toEqual({ type: 'leaf', leafId: LEFT })
  })
})
