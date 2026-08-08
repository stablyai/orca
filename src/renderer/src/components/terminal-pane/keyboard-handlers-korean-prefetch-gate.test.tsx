// @vitest-environment happy-dom
// The Korean input-source probe shells out to `defaults export | plutil | plutil` — four processes
// in the main process — on a 2 s refresh cooldown. terminalKoreanWonToBackquote defaults to off, so
// prefetching it for every macOS user spends that on a feature almost nobody has enabled.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const prefetchKoreanInputSource = vi.fn()
vi.mock('@/lib/keyboard-layout/korean-input-source', () => ({
  prefetchKoreanInputSource: (...args: unknown[]) => prefetchKoreanInputSource(...args),
  isKoreanInputSourceActive: () => false,
  isKoreanInputSourceId: () => false
}))

import { useTerminalKeyboardShortcuts } from './keyboard-handlers'

type KeyboardHandlersDeps = Parameters<typeof useTerminalKeyboardShortcuts>[0]

function deps(koreanWonToBackquoteEnabled: boolean): KeyboardHandlersDeps {
  const scope = document.createElement('div')
  document.body.appendChild(scope)
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    isActive: true,
    keyboardScopeRef: { current: scope },
    managerRef: { current: null },
    paneTransportsRef: { current: new Map() },
    panePtyBindingsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    fallbackCwd: '/tmp',
    koreanWonToBackquoteEnabled,
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen: vi.fn(),
    onSearchSelectedText: vi.fn(),
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    searchOpenRef: { current: false },
    searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
    macOptionAsAltRef: { current: 'off' },
    paneKittyKeyboardModesRef: { current: null }
  } as unknown as KeyboardHandlersDeps
}

beforeEach(() => {
  prefetchKoreanInputSource.mockClear()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Korean input-source prefetch gate', () => {
  it('does not probe the input source when the setting is off', () => {
    renderHook(() => useTerminalKeyboardShortcuts(deps(false)))
    expect(prefetchKoreanInputSource).not.toHaveBeenCalled()
  })

  it('probes once the setting is on', () => {
    renderHook(() => useTerminalKeyboardShortcuts(deps(true)))
    expect(prefetchKoreanInputSource).toHaveBeenCalled()
  })
})
