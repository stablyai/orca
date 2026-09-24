// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'

type MockShortcutStore = {
  settings: { experimentalTiledAgents?: boolean }
  activeWorktreeId: string | null
  keybindings: Record<string, unknown>
  activeGroupIdByWorktree: Record<string, string>
  groupsByWorktree: Record<string, TabGroup[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  focusAgentCardByIndex: ReturnType<typeof vi.fn>
  toggleMaximizedAgentCard: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({ focusTerminalTabSurface: vi.fn() }))

const store = vi.hoisted((): MockShortcutStore => ({
  settings: { experimentalTiledAgents: true },
  activeWorktreeId: 'wt-1',
  keybindings: {},
  activeGroupIdByWorktree: {},
  groupsByWorktree: {},
  unifiedTabsByWorktree: {},
  focusAgentCardByIndex: vi.fn(),
  toggleMaximizedAgentCard: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: typeof store) => unknown) => selector(store), {
    getState: () => store
  })
}))

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => process.platform }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

import { useTiledAgentsShortcuts } from './use-tiled-agents-shortcuts'

// Mod+Alt+<digit>: meta+alt on darwin, control+alt elsewhere (mirrors tiled-agents-shortcuts.test.ts).
function modAltDigitInit(digit: number): KeyboardEventInit {
  const isMac = process.platform === 'darwin'
  return {
    key: String(digit),
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: true,
    shiftKey: false,
    bubbles: true,
    cancelable: true
  }
}

// Mod+Alt+Enter: meta+alt on darwin, control+alt elsewhere (mirrors tiled-agents-shortcuts.test.ts).
function modAltEnterInit(repeat: boolean): KeyboardEventInit {
  const isMac = process.platform === 'darwin'
  return {
    key: 'Enter',
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: true,
    shiftKey: false,
    repeat,
    bubbles: true,
    cancelable: true
  }
}

beforeEach(() => {
  // Why reset, not clear: a few tests below set focusAgentCardByIndex's mockImplementation,
  // which a mere clear would leak into the next test's call.
  vi.resetAllMocks()
  store.settings = { experimentalTiledAgents: true }
  store.activeWorktreeId = 'wt-1'
  store.activeGroupIdByWorktree = {}
  store.groupsByWorktree = {}
  store.unifiedTabsByWorktree = {}
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTiledAgentsShortcuts global-off parity', () => {
  it('registers no keydown listener while the global experiment is off', () => {
    store.settings = { experimentalTiledAgents: false }
    const addSpy = vi.spyOn(window, 'addEventListener')

    renderHook(() => useTiledAgentsShortcuts())

    expect(addSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('registers a keydown listener while the global experiment is on', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')

    renderHook(() => useTiledAgentsShortcuts())

    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('removes the keydown listener the instant the global experiment turns off', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { rerender } = renderHook(() => useTiledAgentsShortcuts())
    const registeredHandler = addSpy.mock.calls.find((call) => call[0] === 'keydown')?.[1]
    expect(registeredHandler).toBeDefined()

    store.settings = { experimentalTiledAgents: false }
    rerender()

    expect(removeSpy).toHaveBeenCalledWith('keydown', registeredHandler)
  })

  it('does not re-add a listener on a re-render while staying enabled', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const { rerender } = renderHook(() => useTiledAgentsShortcuts())
    const keydownCallsBefore = addSpy.mock.calls.filter((call) => call[0] === 'keydown').length

    rerender()

    const keydownCallsAfter = addSpy.mock.calls.filter((call) => call[0] === 'keydown').length
    expect(keydownCallsAfter).toBe(keydownCallsBefore)
  })
})

describe('useTiledAgentsShortcuts both-gates and editable-target bail (finding 7)', () => {
  it('no-ops when focusAgentCardByIndex reports the card was not handled', () => {
    store.focusAgentCardByIndex.mockReturnValue(false)
    renderHook(() => useTiledAgentsShortcuts())

    window.dispatchEvent(new KeyboardEvent('keydown', modAltDigitInit(1)))

    expect(store.focusAgentCardByIndex).toHaveBeenCalledWith('wt-1', 0)
  })

  it('bails when the keydown target is an editable element (input)', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    renderHook(() => useTiledAgentsShortcuts())

    input.dispatchEvent(new KeyboardEvent('keydown', modAltDigitInit(1)))

    expect(store.focusAgentCardByIndex).not.toHaveBeenCalled()
    expect(store.toggleMaximizedAgentCard).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('bails when the keydown target is a textarea or a contenteditable element', () => {
    const textarea = document.createElement('textarea')
    const editableDiv = document.createElement('div')
    editableDiv.contentEditable = 'true'
    document.body.appendChild(textarea)
    document.body.appendChild(editableDiv)
    renderHook(() => useTiledAgentsShortcuts())

    textarea.dispatchEvent(new KeyboardEvent('keydown', modAltDigitInit(1)))
    editableDiv.dispatchEvent(new KeyboardEvent('keydown', modAltDigitInit(2)))

    expect(store.focusAgentCardByIndex).not.toHaveBeenCalled()
    document.body.removeChild(textarea)
    document.body.removeChild(editableDiv)
  })
})

describe('useTiledAgentsShortcuts routes real DOM/composer focus after focusPane (finding 5)', () => {
  beforeEach(() => {
    store.groupsByWorktree = {
      'wt-1': [
        {
          id: 'group-terminal',
          worktreeId: 'wt-1',
          activeTabId: 'tab-terminal',
          tabOrder: ['tab-terminal']
        },
        { id: 'group-agent', worktreeId: 'wt-1', activeTabId: 'tab-agent', tabOrder: ['tab-agent'] }
      ]
    }
    store.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'tab-terminal',
          entityId: 'terminal-entity-1',
          groupId: 'group-terminal',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        },
        {
          id: 'tab-agent',
          entityId: 'session-1',
          groupId: 'group-agent',
          worktreeId: 'wt-1',
          contentType: 'agent-session',
          label: 'Agent',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 0
        }
      ]
    }
  })

  it('routes DOM focus into the terminal surface when the focused pane is a terminal leaf', () => {
    store.focusAgentCardByIndex.mockImplementation((worktreeId: string) => {
      store.activeGroupIdByWorktree[worktreeId] = 'group-terminal'
      return true
    })
    renderHook(() => useTiledAgentsShortcuts())

    window.dispatchEvent(new KeyboardEvent('keydown', modAltDigitInit(1)))

    expect(store.focusAgentCardByIndex).toHaveBeenCalledWith('wt-1', 0)
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-entity-1')
  })

  it('leaves a native-chat agent pane to its own composer reveal edge, with no terminal-surface call', () => {
    store.focusAgentCardByIndex.mockImplementation((worktreeId: string) => {
      store.activeGroupIdByWorktree[worktreeId] = 'group-agent'
      return true
    })
    renderHook(() => useTiledAgentsShortcuts())

    window.dispatchEvent(new KeyboardEvent('keydown', modAltDigitInit(2)))

    expect(store.focusAgentCardByIndex).toHaveBeenCalledWith('wt-1', 1)
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })

  it('does not route surface focus when focusAgentCardByIndex reports the pane was not handled', () => {
    store.focusAgentCardByIndex.mockReturnValue(false)
    renderHook(() => useTiledAgentsShortcuts())

    window.dispatchEvent(new KeyboardEvent('keydown', modAltDigitInit(9)))

    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})

describe('useTiledAgentsShortcuts ignores a held toggleMaximize repeat (C3)', () => {
  // Why count deltas, not toHaveBeenCalledTimes: earlier tests in this file mount the hook
  // without unmounting it, so their listeners stay attached and would also answer a dispatch
  // on window, inflating any absolute call count. A delta isolates this test's own dispatch.
  it('toggles maximize on the initial (non-repeat) keydown', () => {
    renderHook(() => useTiledAgentsShortcuts())
    const before = store.toggleMaximizedAgentCard.mock.calls.length

    window.dispatchEvent(new KeyboardEvent('keydown', modAltEnterInit(false)))

    expect(store.toggleMaximizedAgentCard.mock.calls.length).toBeGreaterThan(before)
    expect(store.toggleMaximizedAgentCard).toHaveBeenCalledWith('wt-1')
  })

  it('does not re-toggle on the repeated keydowns a held key emits', () => {
    renderHook(() => useTiledAgentsShortcuts())
    window.dispatchEvent(new KeyboardEvent('keydown', modAltEnterInit(false)))
    const afterInitial = store.toggleMaximizedAgentCard.mock.calls.length

    window.dispatchEvent(new KeyboardEvent('keydown', modAltEnterInit(true)))
    window.dispatchEvent(new KeyboardEvent('keydown', modAltEnterInit(true)))

    expect(store.toggleMaximizedAgentCard.mock.calls.length).toBe(afterInitial)
  })

  it('still focuses a pane by index on a repeated keydown, since that branch is unguarded', () => {
    renderHook(() => useTiledAgentsShortcuts())

    window.dispatchEvent(new KeyboardEvent('keydown', { ...modAltDigitInit(1), repeat: true }))

    expect(store.focusAgentCardByIndex).toHaveBeenCalledWith('wt-1', 0)
  })
})
