// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { focusPanePreservingOverlays } from '@/lib/pane-manager/pane-overlay-focus'

const state = {
  keybindings: undefined,
  revealWorktreeInSidebar: vi.fn(),
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
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => activate(...args)
}))
vi.mock('@/runtime/mounted-terminal-tab-registry', () => ({
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

  activate.mockImplementation((id: string) => {
    state.activeWorktreeId = id
    state.activeTabId = `tab-${id}`
    setActiveId(id)
    autoFocus()
  })
  const { handleContainerKeyDown } = useWorktreeListKeyboardNavigation({
    rows,
    activeWorktreeId: activeId,
    activeWorkspaceExecutionHostId: 'ssh:fixture',
    pinnedDisplayPolicy: 'single-location',
    scrollRef,
    activeModal: modal,
    markDirectScrollInput: () => {}
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
  const event = new KeyboardEvent('keydown', {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  // Why: happy-dom reports AltGraph for any Alt; Chromium only for a real AltGr key.
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  Object.assign(state, {
    keybindings: undefined,
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

  it('leaves the default chord to text fields and runs a user-bound one', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
    const composer = document.createElement('div')
    composer.contentEditable = 'true'
    composer.setAttribute('data-native-chat-prompt-editor', 'true')
    const editor = document.createElement('div')
    editor.className = 'monaco-editor'
    const field = editor.appendChild(document.createElement('textarea'))
    const reachedField = vi.fn()
    field.addEventListener('keydown', reachedField)
    document.body.append(composer, editor)
    const fieldKeepsChord = (target: HTMLElement) =>
      !press('ArrowDown', { metaKey: true, shiftKey: true }, target).defaultPrevented
    expect([composer, field].map(fieldKeepsChord)).toEqual([true, true])

    const navigateDown = ['Mod+Shift+ArrowDown', 'Ctrl+Alt+ArrowDown', 'Alt+ArrowDown', 'Alt+L']
    Object.assign(state, { keybindings: { 'worktree.navigateDown': navigateDown } })
    act(() => root.render(<Probe />))
    expect([composer, field].map(fieldKeepsChord)).toEqual([true, true])
    // Option+L composes a character on Mac, so the field keeps it even when bound.
    press('¬', { code: 'KeyL', altKey: true }, composer)
    expect(activate).not.toHaveBeenCalled()
    press('ArrowDown', { altKey: true }, composer)
    press('ArrowDown', { ctrlKey: true, altKey: true }, field)
    expect(activate.mock.calls.map(([id]) => id)).toEqual(['b', 'c'])
    expect(reachedField).toHaveBeenCalledTimes(2)
  })
})
