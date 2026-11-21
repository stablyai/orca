// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { AppRail } from './AppRail'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
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

function showDestinations(tasks: boolean, automations: boolean): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      showTasksButton: tasks,
      showAutomationsButton: automations
    }
  })
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

  fireEvent.keyDown(settings, { key: 'Home' })
  expect(workspaces).toHaveFocus()
  fireEvent.keyDown(workspaces, { key: 'ArrowUp' })
  expect(settings).toHaveFocus()
  fireEvent.keyDown(settings, { key: 'ArrowDown' })
  expect(workspaces).toHaveFocus()
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
  showDestinations(false, false)
  toolbarHeight = 108
  renderRail()
  expect(railItems()).toEqual(['workspaces', 'help', 'settings'])
  await resizeTo(107)
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
  expect(screen.queryByRole('button', { name: 'Help' })).not.toBeInTheDocument()
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

it('names the landmark and its toolbar differently', () => {
  renderRail()
  expect(screen.getByRole('navigation', { name: 'App navigation' })).toBeInTheDocument()
  expect(screen.getByRole('toolbar', { name: 'App tools' })).toBeInTheDocument()
})

it('shows Tasks and Automations below Workspaces per their visibility settings', () => {
  showDestinations(true, true)
  renderRail()
  expect(railItems()).toEqual(['workspaces', 'tasks', 'automations', 'help', 'settings'])
  cleanup()
  showDestinations(false, true)
  renderRail()
  expect(railItems()).toEqual(['workspaces', 'automations', 'help', 'settings'])
})

it('selects rail destinations by click and keyboard and updates the current page', async () => {
  showDestinations(true, true)
  renderRail()
  const user = userEvent.setup()
  const tasks = screen.getByRole('button', { name: 'Tasks' })
  const automations = screen.getByRole('button', { name: 'Automations' })

  await user.click(tasks)
  expect(useAppStore.getState().activeView).toBe('tasks')
  expect(tasks).toHaveAttribute('aria-current', 'page')

  await user.keyboard('{ArrowDown}')
  expect(automations).toHaveFocus()
  await user.keyboard(' ')
  expect(useAppStore.getState().activeView).toBe('automations')
  expect(automations).toHaveAttribute('aria-current', 'page')
  expect(tasks).not.toHaveAttribute('aria-current')
})

it('folds Tasks and Automations into More and opens them from there, with More current for a folded page', async () => {
  showDestinations(true, true)
  toolbarHeight = 144
  renderRail()
  expect(railItems()).toEqual(['workspaces', 'more', 'help', 'settings'])
  const more = screen.getByRole('button', { name: 'More' })
  act(() => more.focus())
  fireEvent.keyDown(more, { key: 'Enter' })
  const menu = await screen.findByRole('menu')
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
  ).toEqual(['Tasks', 'Automations'])
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Automations' }))
  expect(useAppStore.getState().activeView).toBe('automations')
  expect(screen.getByRole('button', { name: 'More, Automations' })).toHaveAttribute(
    'aria-current',
    'page'
  )
})

it('leaves an already-open destination as it is', () => {
  showDestinations(true, true)
  useAppStore.getState().openTaskPage({ taskSource: 'linear' })
  renderRail()
  fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
  expect(useAppStore.getState().taskPageData).toEqual({ taskSource: 'linear' })
})
