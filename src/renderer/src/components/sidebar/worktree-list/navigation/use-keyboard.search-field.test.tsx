// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { HostSectionRow } from '../../host-section-rows'
import type { RenderRow } from '../listing/render-row'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { KeybindingOverrides } from '../../../../../../shared/keybindings'

const activateAndRevealWorktree = vi.fn()

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => activateAndRevealWorktree(...args)
}))

const state: { keybindings: KeybindingOverrides } = { keybindings: {} }
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function localRow(id: string): HostSectionRow {
  return {
    type: 'item',
    rowKey: `row:${id}`,
    sectionKey: 'repo:repo-1',
    worktree: { ...worktree, id, repoId: repo.id },
    repo,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

const rows: HostSectionRow[] = [localRow('a'), localRow('b'), localRow('c')]
// Empty on purpose: the reveal lookup then returns -1, so the virtualizer is never called.
const renderRows: RenderRow[] = []

let container: HTMLDivElement
let root: Root
let focusHost: HTMLDivElement

function pressNextWorktreeOn(target: Element, init: KeyboardEventInit = {}): void {
  const mod = getShortcutPlatform() === 'darwin' ? { metaKey: true } : { ctrlKey: true }
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...mod,
        ...init
      })
    )
  })
}

function renderProbe(): void {
  function Probe(): null {
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: 0,
      getScrollElement: () => container,
      estimateSize: () => 30
    })
    useWorktreeListKeyboardNavigation({
      rows,
      renderRows,
      activeWorktreeId: 'b',
      activeWorkspaceExecutionHostId: null,
      pinnedDisplayPolicy: 'single-location',
      virtualizer,
      scrollRef: { current: null },
      activeModal: 'none',
      markDirectScrollInput: () => {}
    })
    return null
  }
  act(() => root.render(<Probe />))
}

function mountFocusTarget(markup: string, selector: string): Element {
  focusHost.innerHTML = markup
  const target = focusHost.querySelector(selector)
  if (!target) {
    throw new Error(`no element matched ${selector}`)
  }
  return target
}

beforeEach(() => {
  activateAndRevealWorktree.mockClear()
  state.keybindings = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  focusHost = document.createElement('div')
  document.body.appendChild(focusHost)
  root = createRoot(container)
  renderProbe()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  focusHost.remove()
})

describe('worktree cycling while a search field holds focus', () => {
  it('cycles from a declared search input', () => {
    const input = mountFocusTarget(
      '<input type="text" data-keyboard-surface="search-field" />',
      'input'
    )

    pressNextWorktreeOn(input)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'keeps the composing search chord with the IME: %j',
    (init) => {
      const input = mountFocusTarget(
        '<input type="text" data-keyboard-surface="search-field" />',
        'input'
      )
      state.keybindings['worktree.navigateDown'] = ['Mod+Q']
      const chord = { key: 'q', code: 'KeyQ', shiftKey: false }
      pressNextWorktreeOn(input, { ...chord, ...init })
      expect(activateAndRevealWorktree).not.toHaveBeenCalled()
      pressNextWorktreeOn(input, chord)
      expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    }
  )

  it.each(['<button>go</button>', '<textarea class="xterm-helper-textarea"></textarea>'])(
    'preserves composing navigation outside opted search fields: %s',
    (markup) => {
      const target = mountFocusTarget(markup, 'button,textarea')
      pressNextWorktreeOn(target, { isComposing: true })
      expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    }
  )

  it('leaves an undeclared text field suppressed', () => {
    const input = mountFocusTarget('<input type="text" />', 'input')

    pressNextWorktreeOn(input)

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('leaves a multiline control suppressed even with a search declaration', () => {
    const textarea = mountFocusTarget(
      '<div data-keyboard-surface="search-field"><textarea data-keyboard-surface="search-field"></textarea></div>',
      'textarea'
    )

    pressNextWorktreeOn(textarea)

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('still cycles when focus is not editable at all', () => {
    const button = mountFocusTarget('<button type="button">go</button>', 'button')

    pressNextWorktreeOn(button)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })
})
