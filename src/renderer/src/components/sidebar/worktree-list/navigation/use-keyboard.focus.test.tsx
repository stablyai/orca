// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostSectionRow } from '../../host-section-rows'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import { focusPanePreservingOverlays } from '@/lib/pane-manager/pane-overlay-focus'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

const state = {
  keybindings: undefined,
  activeView: 'terminal',
  activeTabType: 'terminal',
  activeWorktreeId: 'a',
  activeTabId: 'tab-a',
  tabsByWorktree: {
    a: [{ id: 'tab-a' }],
    b: [{ id: 'tab-b' }],
    c: [{ id: 'tab-c' }],
    'folder:one': [{ id: 'folder-tab' }]
  }
}
const activate = vi.fn()
const focusRuntime = vi.fn()
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => activate(...args)
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  focusRuntimeTerminalSurface: (...args: unknown[]) => focusRuntime(...args)
}))
const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const rows: HostSectionRow[] = ['a', 'b', 'c'].map((id) => ({
  type: 'item',
  rowKey: id,
  sectionKey: repo.id,
  worktree: { ...worktree, id, hostId: 'ssh:fixture' },
  repo,
  depth: 0,
  groupDepth: 0,
  lineageTrail: [],
  isLastLineageChild: false,
  lineageChildCount: 0
}))
let root: Root
let container: HTMLDivElement
let list: HTMLDivElement
let terminal: Terminal
let textarea: HTMLTextAreaElement
let autoFocus: () => void
let modal = 'none'

function Probe() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState(state.activeWorktreeId)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30
  })
  activate.mockImplementation((id: string) => {
    state.activeWorktreeId = id
    state.activeTabId = `tab-${id}`
    setActiveId(id)
    autoFocus()
  })
  const { handleContainerKeyDown } = useWorktreeListKeyboardNavigation({
    rows,
    renderRows: rows,
    activeWorktreeId: activeId,
    activeWorkspaceExecutionHostId: 'ssh:fixture',
    pinnedDisplayPolicy: 'single-location',
    virtualizer,
    scrollRef,
    activeModal: modal,
    markDirectScrollInput: () => {},
    selectedWorktrees: [],
    onNavigate: () => {}
  })
  return (
    <div
      ref={scrollRef}
      data-worktree-sidebar
      role="listbox"
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
    >
      <button>Row action</button>
    </div>
  )
}

function press(key: string, init: KeyboardEventInit = {}, target: HTMLElement = list) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...init })
    )
  })
}

beforeEach(() => {
  Object.assign(state, {
    activeView: 'terminal',
    activeTabType: 'terminal',
    activeWorktreeId: 'a',
    activeTabId: 'tab-a'
  })
  activate.mockReset()
  focusRuntime.mockReset()
  modal = 'none'
  container = document.createElement('div')
  textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  document.body.append(container, textarea)
  terminal = new Terminal()
  vi.spyOn(terminal, 'focus').mockImplementation(() => textarea.focus())
  autoFocus = () => focusPanePreservingOverlays({ container, terminal })
  root = createRoot(container)
  act(() => root.render(<Probe />))
  const element = container.querySelector('[data-worktree-sidebar]')
  if (!(element instanceof HTMLDivElement)) {
    throw new Error('List missing')
  }
  list = element
  list.focus()
})

afterEach(() => {
  act(() => root.unmount())
  terminal.dispose()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('workspace list focus ownership', () => {
  it('keeps repeated arrows in the list across activation and rerenders', () => {
    press('ArrowDown')
    expect(document.activeElement).toBe(list)
    press('ArrowDown')
    expect(document.activeElement).toBe(list)
    press('ArrowUp')
    expect(activate.mock.calls.map(([id]) => id)).toEqual(['b', 'c', 'b'])
    expect(activate).toHaveBeenLastCalledWith('b', {
      navigationIntent: 'user-open',
      revealInSidebar: false,
      executionHostId: 'ssh:fixture'
    })
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('keeps delayed terminal readiness from taking focus', () => {
    autoFocus = () => {}
    press('ArrowDown')
    focusPanePreservingOverlays({ container, terminal })
    expect(document.activeElement).toBe(list)
  })

  it.each(['inside', 'outside'])(
    'releases ownership before an explicit %s pointer action',
    (where) => {
      press('ArrowDown')
      const target = where === 'inside' ? list : textarea
      target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      focusPanePreservingOverlays({ container, terminal })
      expect(document.activeElement).toBe(textarea)
    }
  )

  it('does not revive old ownership when leaving and reentering the list', () => {
    press('ArrowDown')
    textarea.focus()
    list.focus()
    focusPanePreservingOverlays({ container, terminal })
    expect(document.activeElement).toBe(textarea)
  })

  it('drops ownership when the list unmounts and remounts', () => {
    press('ArrowDown')
    act(() => root.render(null))
    focusPanePreservingOverlays({ container, terminal })
    expect(document.activeElement).toBe(textarea)
    act(() => root.render(<Probe />))
    container.querySelector<HTMLElement>('[data-worktree-sidebar]')?.focus()
    focusPanePreservingOverlays({ container, terminal })
    expect(document.activeElement).toBe(textarea)
  })

  it.each(['Mac', 'Windows', 'Linux'])(
    'keeps CmdOrCtrl cycling as terminal navigation on %s',
    (platform) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      press('ArrowDown')
      const mod = getShortcutPlatform() === 'darwin' ? { metaKey: true } : { ctrlKey: true }
      press('ArrowDown', { ...mod, shiftKey: true })
      expect(activate.mock.calls.map(([id]) => id)).toEqual(['b', 'c'])
      expect(document.activeElement).toBe(textarea)
    }
  )

  it('does not navigate while an application modal is active', () => {
    modal = 'settings'
    act(() => root.render(<Probe />))
    press('ArrowDown')
    press('Enter')
    expect(activate).not.toHaveBeenCalled()
    expect(focusRuntime).not.toHaveBeenCalled()
  })

  it.each(['dialog', 'menu'])('does not navigate behind a visible %s', (role) => {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', role)
    document.body.append(overlay)
    press('ArrowDown')
    press('Enter')
    expect(activate).not.toHaveBeenCalled()
    expect(focusRuntime).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(list)
  })

  it('does not consume Enter from a row action', () => {
    const button = list.querySelector('button')
    if (!button) {
      throw new Error('Button missing')
    }
    button.focus()
    press('Enter', {}, button)
    expect(document.activeElement).toBe(button)
    expect(focusRuntime).not.toHaveBeenCalled()
  })

  it('asks the workspace-scoped pane API to focus the selected active pane', () => {
    press('ArrowDown')
    focusRuntime.mockImplementation(() => {
      textarea.focus()
      return true
    })
    press('Enter')
    expect(focusRuntime).toHaveBeenCalledWith('tab-b', null, 'b')
    expect(document.activeElement).toBe(textarea)
    expect(list.hasAttribute('data-keyboard-navigation')).toBe(false)
  })

  it('uses folder workspace identity when handing focus to its terminal', () => {
    Object.assign(state, { activeWorktreeId: 'folder:one', activeTabId: 'folder-tab' })
    press('Enter')
    expect(focusRuntime).toHaveBeenCalledWith('folder-tab', null, 'folder:one')
  })

  it.each([false, true])(
    'keeps ownership when Enter returns %s without moving focus',
    (handled) => {
      press('ArrowDown')
      focusRuntime.mockReturnValue(handled)
      press('Enter')
      expect(document.activeElement).toBe(list)
      focusPanePreservingOverlays({ container, terminal })
      expect(document.activeElement).toBe(list)
      expect(terminal.focus).not.toHaveBeenCalled()
    }
  )

  it.each(['editor', 'browser', 'agent', 'empty', 'unowned', 'unmounted', 'other-view'])(
    'leaves focus in the list for %s targets instead of another terminal',
    (target) => {
      if (['editor', 'browser', 'agent'].includes(target)) {
        state.activeTabType = target
      }
      if (target === 'empty') {
        state.activeWorktreeId = ''
      }
      if (target === 'unowned') {
        state.activeTabId = 'tab-b'
      }
      if (target === 'other-view') {
        state.activeView = 'settings'
      }
      focusRuntime.mockReturnValue(false)
      press('Enter')
      expect(document.activeElement).toBe(list)
      if (target !== 'unmounted') {
        expect(focusRuntime).not.toHaveBeenCalled()
      }
    }
  )
})
