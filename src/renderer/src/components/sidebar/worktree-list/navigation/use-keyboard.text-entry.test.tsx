// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { HostSectionRow } from '../../host-section-rows'
import type { RenderRow } from '../listing/render-row'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

const activateAndRevealWorktree = vi.fn()

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => activateAndRevealWorktree(...args)
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { keybindings: undefined }) => unknown) =>
    selector({ keybindings: undefined })
}))

const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function localRow(id: string): HostSectionRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cycling reads only worktree.id off a row; a literal Worktree/Repo would pin ~50 fields this behavior never touches.
  return {
    type: 'item',
    rowKey: `row:${id}`,
    sectionKey: 'repo:repo-1',
    worktree: { id, repoId: 'repo-1' },
    repo: { id: 'repo-1', path: '/repo-1', displayName: 'Repo 1' },
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  } as unknown as HostSectionRow
}

const rows: HostSectionRow[] = [localRow('a'), localRow('b'), localRow('c')]
// Empty on purpose: the reveal lookup then returns -1, so the virtualizer is never called.
const renderRows: RenderRow[] = []
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unreachable while renderRows is empty; the hook calls scrollToIndex only for a found row index.
const virtualizer = {} as Virtualizer<HTMLDivElement, HTMLDivElement>

let container: HTMLDivElement
let root: Root
let focusHost: HTMLDivElement

function pressNextWorktreeOn(target: Element): void {
  const mod = getShortcutPlatform() === 'darwin' ? { metaKey: true } : { ctrlKey: true }
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...mod
      })
    )
  })
}

function renderProbe(): void {
  function Probe(): null {
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

describe('worktree cycling while a text surface holds focus', () => {
  it('cycles from a one-line field that declares it owns no vertical caret', () => {
    // The search box: Cmd/Ctrl+Shift+Arrow has no meaning on a single line, so the
    // app action stays reachable without tabbing out of the field first.
    const input = mountFocusTarget(
      '<div data-keyboard-surface="text-field"><input type="text" /></div>',
      'input'
    )

    pressNextWorktreeOn(input)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {})
  })

  it('leaves an undeclared text field suppressed', () => {
    const input = mountFocusTarget('<input type="text" />', 'input')

    pressNextWorktreeOn(input)

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('leaves a multiline control suppressed even inside a declared region', () => {
    const textarea = mountFocusTarget(
      '<div data-keyboard-surface="text-field"><textarea></textarea></div>',
      'textarea'
    )

    pressNextWorktreeOn(textarea)

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('still cycles when focus is not editable at all', () => {
    const button = mountFocusTarget('<button type="button">go</button>', 'button')

    pressNextWorktreeOn(button)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {})
  })
})
