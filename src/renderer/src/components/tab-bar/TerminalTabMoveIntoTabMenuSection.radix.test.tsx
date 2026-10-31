/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  intoPaneState,
  SOURCE,
  sourceLayout,
  TARGET,
  targetLayout,
  terminalTab,
  WT
} from '../terminal-pane/terminal-tab-into-pane-fixture'
import type { TerminalTabIntoPaneState } from '../terminal-pane/terminal-tab-into-pane-eligibility'
import { TerminalTabMoveIntoTabMenuSection } from './TerminalTabMoveIntoTabMenuSection'

// The window-applied join under test exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const moveMock = vi.hoisted(() => vi.fn())
const storeMock = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state }
})

vi.mock('@/components/terminal-pane/terminal-tab-into-pane-deps', () => ({
  moveTerminalTabIntoPaneInApp: moveMock
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeMock.state)
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function seedState(patch: Partial<TerminalTabIntoPaneState> = {}): void {
  moveMock.mockReset()
  for (const key of Object.keys(storeMock.state)) {
    delete storeMock.state[key]
  }
  Object.assign(
    storeMock.state,
    intoPaneState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, 'pty-a', { title: 'build' }),
          terminalTab(TARGET, 'pty-b', { title: 'server' })
        ]
      },
      ...patch
    }),
    { tabBarOrderByWorktree: { [WT]: [SOURCE, TARGET] } }
  )
}

/** The real Radix menu, opened by a right-click, so disabled and submenu behaviour come from Radix itself. */
function renderOpenMenu(): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <ContextMenu>
        <ContextMenuTrigger>menu</ContextMenuTrigger>
        <ContextMenuContent>
          <TerminalTabMoveIntoTabMenuSection tabId={SOURCE} worktreeId={WT} />
        </ContextMenuContent>
      </ContextMenu>
    )
  })
  mounted.push({ container, root })
  const trigger = container.querySelector('[data-slot="context-menu-trigger"]')
  if (!trigger) {
    throw new Error('Missing menu trigger')
  }
  act(() => {
    trigger.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 })
    )
  })
}

function menuItem(name: string): HTMLElement {
  const found = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.startsWith(name)
  )
  if (!found) {
    throw new Error(`Missing menu item: ${name}`)
  }
  return found
}

function openSubmenu(trigger: HTMLElement): void {
  act(() => {
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
}

beforeEach(() => seedState())

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('TerminalTabMoveIntoTabMenuSection in the real context menu', () => {
  it('marks Move Into Tab disabled for a source-wide refusal, and a submenu never opens from it', () => {
    seedState({ terminalLayoutsByTabId: { [SOURCE]: targetLayout(), [TARGET]: targetLayout() } })
    renderOpenMenu()

    const trigger = menuItem('Move Into Tab')
    expect(trigger.getAttribute('aria-disabled')).toBe('true')
    expect(trigger.hasAttribute('data-disabled')).toBe(true)
    expect(trigger.textContent).toContain('Tab has several panes')

    openSubmenu(trigger)
    expect(document.body.textContent).not.toContain('server')
  })

  it('opens the target list and the side list, and a pick reaches the move', () => {
    renderOpenMenu()

    const trigger = menuItem('Move Into Tab')
    expect(trigger.getAttribute('aria-disabled')).toBeNull()
    openSubmenu(trigger)
    const target = menuItem('server')
    expect(target.getAttribute('aria-disabled')).toBeNull()
    openSubmenu(target)
    act(() => menuItem('Split Down').click())

    expect(moveMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTabId: SOURCE, targetTabId: TARGET, side: 'bottom' })
    )
  })

  it('a target that refuses is a disabled item that does not move when clicked', () => {
    seedState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, 'pty-a', { title: 'build' }),
          terminalTab(TARGET, 'pty-b', { title: 'server', viewMode: 'chat' })
        ]
      },
      terminalLayoutsByTabId: { [SOURCE]: sourceLayout(), [TARGET]: targetLayout() }
    })
    renderOpenMenu()

    openSubmenu(menuItem('Move Into Tab'))
    const target = menuItem('server')
    expect(target.getAttribute('aria-disabled')).toBe('true')
    expect(target.textContent).toContain('Chat view')
    act(() => target.click())

    expect(moveMock).not.toHaveBeenCalled()
  })
})
