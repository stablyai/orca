// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { AppRail } from './AppRail'
import type * as HelpMenuControllerModule from '@/components/sidebar/chrome/help-menu-controller'
import { setWorkspaceListRegionPresent } from './workspace-list-region-presence'
import {
  registerTitlebarSidebarToggle,
  unregisterTitlebarSidebarToggle
} from '@/app-shell/chrome/titlebar-sidebar-toggle-ref'

// The real dialog lazy-loads heavy feedback code; the rail only cares that one instance stays open.
vi.mock('@/components/sidebar/sidebar-feedback/SidebarFeedbackDialog', () => ({
  SidebarFeedbackDialog: ({
    open,
    onOpenChange
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div role="dialog" aria-label="Send feedback">
        <textarea aria-label="Feedback text" />
        <button type="button" onClick={() => onOpenChange(false)}>
          Close feedback
        </button>
      </div>
    ) : null
}))

// Counts rail body executions: the rail calls its Help controller hook exactly once per render.
let railRenders = 0
vi.mock('@/components/sidebar/chrome/help-menu-controller', async (importOriginal) => {
  const actual = await importOriginal<typeof HelpMenuControllerModule>()
  return {
    ...actual,
    useHelpMenuController: (...args: Parameters<typeof actual.useHelpMenuController>) => {
      railRenders += 1
      return actual.useHelpMenuController(...args)
    }
  }
})

const initialState = useAppStore.getState()

let toolbarHeight = 1000
// happy-dom has no layout; the rail measures its toolbar box.
const originalRect = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  return this.getAttribute('role') === 'toolbar'
    ? new DOMRect(0, 0, 40, toolbarHeight)
    : originalRect.call(this)
}

let resizeCallbacks: (() => void)[] = []
const OriginalResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  useAppStore.setState({ activeView: 'terminal', sidebarBody: 'workspaces', sidebarOpen: true })
  resizeCallbacks = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a minimal ResizeObserver stub; the rail only constructs it and calls observe/disconnect.
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      // The rail's measure callback takes no entries; other observers (Radix) expect real ones.
      if (callback.length === 0) {
        resizeCallbacks.push(callback)
      }
    }
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  toolbarHeight = 1000
  setWorkspaceListRegionPresent(false)
  globalThis.ResizeObserver = OriginalResizeObserver
  useAppStore.setState(initialState, true)
})

function focusedElement(): HTMLElement {
  const element = document.activeElement
  if (!(element instanceof HTMLElement)) {
    throw new Error('expected a focused element')
  }
  return element
}

function focusedElementOrNull(): HTMLElement | null {
  const element = document.activeElement
  return element instanceof HTMLElement ? element : null
}

function renderRail(): void {
  render(
    <TooltipProvider>
      <AppRail listVisible />
    </TooltipProvider>
  )
}

function railItems(): string[] {
  return Array.from(document.querySelectorAll('[data-app-rail-item]')).map(
    (element) => element.getAttribute('data-app-rail-item') ?? ''
  )
}

async function resizeTo(height: number): Promise<void> {
  toolbarHeight = height
  act(() => resizeCallbacks.forEach((callback) => callback()))
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
}

it('moves focus with ArrowDown on the Help trigger instead of opening its menu', async () => {
  renderRail()
  const help = screen.getByRole('button', { name: 'Help' })
  act(() => help.focus())
  fireEvent.keyDown(help, { key: 'ArrowDown' })
  await act(async () => {})
  expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus()
  expect(help).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('keeps a single tab stop that follows the last focused item', () => {
  renderRail()
  const workspaces = screen.getByRole('button', { name: 'Workspaces' })
  const settings = screen.getByRole('button', { name: 'Settings' })
  expect(workspaces).toHaveAttribute('tabindex', '0')
  expect(settings).toHaveAttribute('tabindex', '-1')
  act(() => workspaces.focus())
  fireEvent.keyDown(workspaces, { key: 'End' })
  expect(settings).toHaveFocus()
  expect(settings).toHaveAttribute('tabindex', '0')
  expect(workspaces).toHaveAttribute('tabindex', '-1')
})

it('leaves arrow keys to the open Help menu and returns focus to Help on Escape', async () => {
  renderRail()
  const help = screen.getByRole('button', { name: 'Help' })
  act(() => help.focus())
  fireEvent.keyDown(help, { key: 'Enter' })
  await act(async () => {})
  const menu = await screen.findByRole('menu')
  const first = focusedElement()
  expect(menu).toContainElement(first)
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  // Radix roving focus moves on the next task.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(menu).toContainElement(focusedElement())
  expect(document.activeElement).not.toBe(first)
  fireEvent.keyDown(focusedElement(), { key: 'Escape' })
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(help).toHaveFocus()
})

it('describes expansion only for workspaces content, pointing at the list only while it exists', () => {
  useAppStore.setState({ sidebarBody: 'agents' })
  renderRail()
  const workspaces = screen.getByRole('button', { name: 'Workspaces' })
  expect(workspaces).not.toHaveAttribute('aria-expanded')
  act(() => useAppStore.setState({ sidebarBody: 'workspaces' }))
  expect(workspaces).toHaveAttribute('aria-expanded', 'true')
  expect(workspaces).not.toHaveAttribute('aria-controls')
  act(() => setWorkspaceListRegionPresent(true))
  expect(workspaces).toHaveAttribute('aria-controls', 'workspace-list-region')
  expect(workspaces).toHaveAccessibleName('Workspaces')
})

it('folds Help and Settings into More when the rail is too short for three buttons', async () => {
  toolbarHeight = 108
  renderRail()
  expect(railItems()).toEqual(['workspaces', 'help', 'settings'])
  await resizeTo(72)
  expect(railItems()).toEqual(['workspaces', 'more'])
  fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' })
  const menu = await screen.findByRole('menu')
  expect(menu).toHaveTextContent('Help')
  expect(menu).toHaveTextContent('Settings')
  await resizeTo(0)
  expect(railItems()).toEqual(['workspaces', 'more'])
})

it('moves focus to More when the focused Settings button folds into it', async () => {
  renderRail()
  act(() => screen.getByRole('button', { name: 'Settings' }).focus())
  await resizeTo(72)
  expect(screen.getByRole('button', { name: 'More' })).toHaveFocus()
})

it('keeps an open feedback dialog when Help folds into More', async () => {
  renderRail()
  const help = screen.getByRole('button', { name: 'Help' })
  act(() => help.focus())
  fireEvent.keyDown(help, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Send Feedback' }))
  const dialog = await screen.findByRole('dialog', { name: 'Send feedback' })
  await resizeTo(72)
  expect(screen.queryByRole('button', { name: 'Help' })).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBe(dialog)
})

async function openFeedbackFromHelp(): Promise<void> {
  const help = screen.getByRole('button', { name: 'Help' })
  act(() => help.focus())
  fireEvent.keyDown(help, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Send Feedback' }))
  await screen.findByRole('dialog', { name: 'Send feedback' })
}

it('leaves focus inside an open feedback dialog when Help folds into More', async () => {
  renderRail()
  await openFeedbackFromHelp()
  const text = screen.getByRole('textbox', { name: 'Feedback text' })
  act(() => text.focus())
  await resizeTo(72)
  expect(text).toHaveFocus()
})

it('does not pull focus back into the rail on a fold after a dialog already closed', async () => {
  renderRail()
  await openFeedbackFromHelp()
  act(() => screen.getByRole('textbox', { name: 'Feedback text' }).focus())
  fireEvent.click(screen.getByRole('button', { name: 'Close feedback' }))
  act(() => focusedElementOrNull()?.blur())
  expect(document.activeElement).toBe(document.body)
  await resizeTo(72)
  expect(document.activeElement).toBe(document.body)
})

function renderRailWithToggle(): { toggle: HTMLButtonElement } {
  const toggle = document.createElement('button')
  toggle.textContent = 'Toggle sidebar'
  document.body.append(toggle)
  registerTitlebarSidebarToggle(toggle)
  renderRail()
  return { toggle }
}

it('hands focus on a rail button to the titlebar toggle when the rail goes away', () => {
  const { toggle } = renderRailWithToggle()
  act(() => screen.getByRole('button', { name: 'Settings' }).focus())
  cleanup()
  expect(toggle).toHaveFocus()
  unregisterTitlebarSidebarToggle(toggle)
  toggle.remove()
})

it('hands focus inside an open rail menu to the titlebar toggle when the rail goes away', async () => {
  const { toggle } = renderRailWithToggle()
  const help = screen.getByRole('button', { name: 'Help' })
  act(() => help.focus())
  fireEvent.keyDown(help, { key: 'Enter' })
  const menu = await screen.findByRole('menu')
  expect(menu).toContainElement(focusedElement())
  cleanup()
  expect(toggle).toHaveFocus()
  unregisterTitlebarSidebarToggle(toggle)
  toggle.remove()
})

it('blurs without error when the rail goes away and no titlebar toggle exists', () => {
  renderRail()
  act(() => screen.getByRole('button', { name: 'Settings' }).focus())
  expect(() => cleanup()).not.toThrow()
  expect(document.activeElement).toBe(document.body)
})

it('leaves connected focus outside the rail untouched when the rail goes away', () => {
  const { toggle } = renderRailWithToggle()
  const outside = document.createElement('input')
  document.body.append(outside)
  act(() => outside.focus())
  cleanup()
  expect(outside).toHaveFocus()
  unregisterTitlebarSidebarToggle(toggle)
  toggle.remove()
  outside.remove()
})

it('renders once per relevant store update', () => {
  renderRail()
  railRenders = 0
  act(() => useAppStore.setState({ sidebarBody: 'agents' }))
  expect(railRenders).toBe(1)
})
