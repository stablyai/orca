// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { useExpandCollapseActions } from './expand-collapse'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'

type ExpandCollapseHookState = Parameters<typeof useExpandCollapseActions>[0]
type KeyboardHandlersDeps = Parameters<typeof useTerminalKeyboardShortcuts>[0]

// Field identities are stable across renders (refs, setState, store actions,
// useCallback); TerminalPane rebuilds only the wrapping object literal.
function createStableFields(): Omit<ExpandCollapseHookState, 'tabId'> {
  return {
    expandedPaneIdRef: { current: null },
    expandedStyleSnapshotRef: { current: new Map() },
    containerRef: { current: null },
    managerRef: { current: null },
    setExpandedPaneId: vi.fn(),
    setTabPaneExpanded: vi.fn(),
    pendingPaneSizeRefreshFrameIdsRef: { current: [] },
    persistLayoutSnapshot: vi.fn()
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useExpandCollapseActions render stability', () => {
  it('keeps all five action identities across rerenders that rebuild the state object', () => {
    const fields = createStableFields()
    const hook = renderHook(() => useExpandCollapseActions({ ...fields, tabId: 'tab-1' }))
    const first = hook.result.current

    hook.rerender()
    hook.rerender()

    const actionNames = Object.keys(first) as (keyof typeof first)[]
    expect(actionNames).toHaveLength(5)
    for (const name of actionNames) {
      expect(Object.is(hook.result.current[name], first[name])).toBe(true)
    }
  })

  it('remints actions when tabId changes', () => {
    const fields = createStableFields()
    const hook = renderHook(({ tabId }) => useExpandCollapseActions({ ...fields, tabId }), {
      initialProps: { tabId: 'tab-1' }
    })
    const first = hook.result.current

    hook.rerender({ tabId: 'tab-2' })

    expect(Object.is(hook.result.current.setExpandedPane, first.setExpandedPane)).toBe(false)
  })
})

describe('terminal keyboard effect registration stability', () => {
  it('registers window listeners once across rerenders with TerminalPane-shaped wiring', () => {
    const scope = document.createElement('div')
    document.body.append(scope)
    const pane = {
      id: 1,
      leafId: '00000000-0000-4000-8000-000000000001',
      terminal: { element: scope, focus: vi.fn(), getSelection: vi.fn(() => '') }
    }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    } as unknown as PaneManager
    const transport = { getPtyId: () => 'pty-1', sendInput: vi.fn(() => true) }
    const fields = createStableFields()
    const stableDeps = {
      tabId: 'tab-1',
      worktreeId: 'worktree-1',
      isActive: true,
      keyboardScopeRef: { current: scope },
      managerRef: { current: manager },
      paneTransportsRef: {
        current: new Map([[pane.id, transport as unknown as PtyTransport]])
      },
      panePtyBindingsRef: { current: new Map() },
      paneCwdRef: { current: new Map() },
      fallbackCwd: '',
      expandedPaneIdRef: { current: null },
      setSearchOpen: vi.fn(),
      onSearchSelectedText: vi.fn(),
      onRequestClosePane: vi.fn(),
      onClearPaneScrollback: vi.fn(),
      onSetTitle: vi.fn(),
      onClearPaneTitle: vi.fn(),
      searchOpenRef: { current: false },
      searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
      macOptionAsAltRef: { current: 'false' as const }
    }

    const addSpy = vi.spyOn(window, 'addEventListener')
    const countBeforeinputAdds = (): number =>
      addSpy.mock.calls.filter(([type]) => type === 'beforeinput').length

    const hook = renderHook(() => {
      // Same wiring shape as TerminalPane: both dep objects are rebuilt every render.
      const actions = useExpandCollapseActions({ ...fields, tabId: stableDeps.tabId })
      useTerminalKeyboardShortcuts({
        ...stableDeps,
        setExpandedPane: actions.setExpandedPane,
        restoreExpandedLayout: actions.restoreExpandedLayout,
        refreshPaneSizes: actions.refreshPaneSizes,
        persistLayoutSnapshot: fields.persistLayoutSnapshot,
        toggleExpandPane: actions.toggleExpandPane
      } as KeyboardHandlersDeps)
    })
    expect(countBeforeinputAdds()).toBe(1)

    for (let render = 0; render < 10; render++) {
      hook.rerender()
    }

    expect(countBeforeinputAdds()).toBe(1)
    hook.unmount()
    scope.remove()
  })
})
