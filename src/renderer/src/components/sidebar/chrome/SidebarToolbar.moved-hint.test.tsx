// @vitest-environment happy-dom

import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Dialog } from 'radix-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import SidebarToolbar from './SidebarToolbar'
import {
  WORKSPACE_BOARD_MOVED_HINT_DURATION_MS,
  WORKSPACE_BOARD_MOVED_HINT_EXIT_MS,
  WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY
} from './use-workspace-board-moved-hint'

const HINT_TEXT = 'Workspace board moved to the bottom bar'
const BOARD_USED = { 'workspace-board': { firstInteractedAt: 1, interactionCount: 1 } }

let windowFocused = true

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  windowFocused = true
  // happy-dom's own focus answers vary by version; the hint's focus gate must be driven explicitly.
  vi.spyOn(document, 'hasFocus').mockImplementation(() => windowFocused)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function seedEligible(): void {
  useAppStore.setState({
    persistedUIReady: true,
    featureInteractions: BOARD_USED,
    workspaceBoardUsedBeforeLaunch: true
  })
}

function Harness({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <StrictMode>
      <TooltipProvider>
        <input aria-label="Composer" />
        <SidebarToolbar workspaceBoardOpen={false} onWorkspaceBoardToggle={() => {}} />
        {children}
      </TooltipProvider>
    </StrictMode>
  )
}

function hintBubble(): Element | null {
  return document.querySelector('[data-workspace-board-moved-hint]')
}

/** Any visible bubble carrying the hint text (also matches the old forced-open tooltip). */
function hintShowing(): boolean {
  return Array.from(
    document.querySelectorAll('[data-workspace-board-moved-hint], [data-slot="tooltip-content"]')
  ).some(
    (bubble) =>
      bubble.getAttribute('data-state') !== 'closed' && bubble.textContent?.includes(HINT_TEXT)
  )
}

function boardButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Workspace board' })
}

/** Presses Escape on the composer-like sibling input and reports whether anything swallowed it. */
function pressEscapeOnSibling(): boolean {
  const input = screen.getByRole('textbox', { name: 'Composer' })
  input.focus()
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    input.dispatchEvent(event)
  })
  return event.defaultPrevented
}

function hoverBoardButton(): void {
  // A real hover enters before it moves.
  fireEvent.pointerEnter(boardButton(), { pointerType: 'mouse' })
  fireEvent.pointerMove(boardButton(), { pointerType: 'mouse' })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

function boardLabel(): Element | null {
  return document.querySelector('[data-slot="tooltip-content"]')
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function focusWindow(): void {
  windowFocused = true
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })
}

function seenKey(): string | null {
  return window.localStorage.getItem(WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY)
}

it('lets Escape through to the rest of the app while the hint shows', () => {
  seedEligible()
  render(<Harness />)
  expect(hintShowing()).toBe(true)

  expect(pressEscapeOnSibling()).toBe(false)
  expect(pressEscapeOnSibling()).toBe(false)
  expect(hintShowing()).toBe(true)
})

it('hides after 12 s under StrictMode with persisted UI ready at mount', () => {
  seedEligible()
  render(<Harness />)
  expect(hintShowing()).toBe(true)
  act(() => {
    vi.advanceTimersByTime(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
  })
  expect(hintShowing()).toBe(false)
})

it('marks the hint seen when it hides, not when it opens', () => {
  seedEligible()
  render(<Harness />)
  expect(hintShowing()).toBe(true)
  expect(seenKey()).toBeNull()

  act(() => {
    vi.advanceTimersByTime(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS - 1)
  })
  expect(hintShowing()).toBe(true)
  expect(seenKey()).toBeNull()

  act(() => {
    vi.advanceTimersByTime(1)
  })
  expect(hintShowing()).toBe(false)
  expect(seenKey()).toBe('true')
})

it('still hides at 12 s when the hint effect re-runs while it is open', () => {
  seedEligible()
  render(<Harness />)
  act(() => {
    vi.advanceTimersByTime(5000)
  })
  // A dependency change while open used to clear the only timer and then return early.
  act(() => {
    useAppStore.setState({ persistedUIReady: false })
  })
  act(() => {
    useAppStore.setState({ persistedUIReady: true })
  })
  act(() => {
    vi.advanceTimersByTime(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
  })
  expect(hintShowing()).toBe(false)
})

it('hides and marks the hint seen when the board button is clicked', () => {
  seedEligible()
  render(<Harness />)
  expect(hintShowing()).toBe(true)

  fireEvent.click(boardButton())
  expect(hintShowing()).toBe(false)
  expect(seenKey()).toBe('true')
})

it('keeps the hover label shut while the hint shows, so two bubbles never stack', () => {
  seedEligible()
  render(<Harness />)
  hoverBoardButton()
  expect(hintShowing()).toBe(true)
  expect(boardLabel()).toBeNull()
  expect(screen.getAllByRole('tooltip').map((tip) => tip.textContent)).toEqual([HINT_TEXT])
})

it('shows the normal hover label after the hint ends, and one Escape closes it', () => {
  seedEligible()
  render(<Harness />)
  advance(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
  advance(WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
  hoverBoardButton()
  expect(boardLabel()?.textContent).toBe('Workspace board')

  // An ordinary label spends one Escape closing itself; the next reaches the app.
  expect(pressEscapeOnSibling()).toBe(true)
  expect(boardLabel()?.getAttribute('data-state') ?? 'closed').toBe('closed')
  expect(pressEscapeOnSibling()).toBe(false)
})

it('lets Escape through after a dialog opens and closes over the hint', () => {
  seedEligible()
  function WithDialog(): React.JSX.Element {
    const [open, setOpen] = React.useState(false)
    return (
      <Harness>
        <button type="button" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Portal>
            <Dialog.Content aria-describedby={undefined}>
              <Dialog.Title>Dialog</Dialog.Title>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </Harness>
    )
  }
  render(<WithDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  act(() => {
    vi.advanceTimersByTime(50)
  })
  expect(screen.queryByRole('dialog')).toBeNull()

  expect(hintShowing()).toBe(true)
  expect(pressEscapeOnSibling()).toBe(false)
})

it('describes the board button by the hint while it shows, without any live region', () => {
  windowFocused = false
  seedEligible()
  render(<Harness />)
  expect(boardButton().getAttribute('aria-describedby')).toBeNull()

  focusWindow()
  expect(hintShowing()).toBe(true)
  // Informational only, like today's label: never announced unprompted.
  expect(screen.queryByRole('status')).toBeNull()
  expect(document.querySelector('[aria-live]')).toBeNull()
  const describedBy = boardButton().getAttribute('aria-describedby')
  expect(describedBy).toBe(hintBubble()?.id)
  expect(document.getElementById(describedBy ?? '')?.textContent).toBe(HINT_TEXT)
  expect(hintBubble()?.getAttribute('role')).toBe('tooltip')
  expect(document.activeElement).toBe(document.body)

  advance(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
  advance(WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
  expect(boardButton().getAttribute('aria-describedby')).toBeNull()
  expect(document.querySelector('[aria-live]')).toBeNull()

  // The ordinary label's own description comes back with it.
  hoverBoardButton()
  expect(boardButton().getAttribute('aria-describedby')).toBe(boardLabel()?.id)
})

it('waits for a focused window before starting, and writes nothing until then', () => {
  windowFocused = false
  seedEligible()
  render(<Harness />)
  act(() => {
    vi.advanceTimersByTime(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS * 2)
  })
  expect(hintBubble()).toBeNull()
  expect(seenKey()).toBeNull()

  windowFocused = true
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(hintShowing()).toBe(true)
  // Once shown, a blur does not pause or cancel the 12 s.
  windowFocused = false
  act(() => {
    window.dispatchEvent(new Event('blur'))
    vi.advanceTimersByTime(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
  })
  expect(hintShowing()).toBe(false)
  expect(seenKey()).toBe('true')
})

it('marks the hint seen when the toolbar unmounts while it shows, not while it waits', () => {
  seedEligible()
  const first = render(<Harness />)
  expect(hintShowing()).toBe(true)
  first.unmount()
  expect(seenKey()).toBe('true')

  window.localStorage.clear()
  windowFocused = false
  const second = render(<Harness />)
  expect(hintBubble()).toBeNull()
  second.unmount()
  expect(seenKey()).toBeNull()
})

it('hides when another window marks the hint seen', () => {
  seedEligible()
  render(<Harness />)
  expect(hintShowing()).toBe(true)
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY, newValue: 'true' })
    )
  })
  expect(hintShowing()).toBe(false)
})

it('keeps the label suppressed through a local fade even if another window marks it seen then', () => {
  seedEligible()
  render(<Harness />)
  // The peer's event lands before React has committed the local dismissal.
  act(() => {
    boardButton().click()
    window.dispatchEvent(
      new StorageEvent('storage', { key: WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY, newValue: 'true' })
    )
  })
  expect(hintShowing()).toBe(false)
  // Still fading out: a hover that starts now must not open the label later.
  fireEvent.pointerMove(boardButton(), { pointerType: 'mouse' })
  advance(WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
  advance(1000)
  expect(boardLabel()).toBeNull()
  expect(pressEscapeOnSibling()).toBe(false)
})

it('drops a hover armed before the hint even when another window ends the hint at once', () => {
  windowFocused = false
  seedEligible()
  render(<Harness />)
  // The hover starts while the hint is still waiting; Radix arms its 600 ms open.
  fireEvent.pointerEnter(boardButton(), { pointerType: 'mouse' })
  fireEvent.pointerMove(boardButton(), { pointerType: 'mouse' })
  advance(100)
  focusWindow()
  expect(hintShowing()).toBe(true)
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY, newValue: 'true' })
    )
  })
  advance(WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
  // The fade is over before the old delay ends; the pointer never moved again.
  advance(1000)
  expect(hintShowing()).toBe(false)
  expect(boardLabel()).toBeNull()
  expect(pressEscapeOnSibling()).toBe(false)

  // A fresh hover afterwards opens the label as usual.
  fireEvent.pointerLeave(boardButton(), { pointerType: 'mouse' })
  hoverBoardButton()
  expect(boardLabel()?.textContent).toBe('Workspace board')
})

it('does not let a focus during the fade revive a hover armed before the hint', () => {
  windowFocused = false
  seedEligible()
  render(<Harness />)
  fireEvent.pointerEnter(boardButton(), { pointerType: 'mouse' })
  fireEvent.pointerMove(boardButton(), { pointerType: 'mouse' })
  advance(100)
  focusWindow()
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY, newValue: 'true' })
    )
  })
  // Tab lands on the board button while the hint is still fading out.
  advance(50)
  fireEvent.focus(boardButton())
  // Past the fade and past the old hover's 600 ms deadline, focus still on the button.
  advance(WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
  advance(1000)
  expect(boardLabel()).toBeNull()
  expect(pressEscapeOnSibling()).toBe(false)

  // Gestures that start after the hint behave normally.
  fireEvent.pointerLeave(boardButton(), { pointerType: 'mouse' })
  hoverBoardButton()
  expect(boardLabel()?.textContent).toBe('Workspace board')
})

function showRailPage(page: 'tasks' | 'terminal'): void {
  act(() => {
    useAppStore.setState((state) => ({
      settings: {
        ...(state.settings ?? getDefaultSettings('/home/test')),
        experimentalAppRail: true
      },
      activeView: page
    }))
  })
}

it('hides the hint without counting it as seen when a rail page hides the list, and shows it again after', () => {
  seedEligible()
  showRailPage('terminal')
  render(<Harness />)
  expect(hintShowing()).toBe(true)
  advance(5000)

  showRailPage('tasks')
  // Gone at once (no fade over the Tasks page) and not marked seen.
  expect(hintBubble()).toBeNull()
  expect(seenKey()).toBeNull()
  advance(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
  expect(hintBubble()).toBeNull()
  expect(seenKey()).toBeNull()

  // Back on Workspaces it shows again for a full 12 s, then counts as seen.
  showRailPage('terminal')
  expect(hintShowing()).toBe(true)
  advance(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS - 1)
  expect(hintShowing()).toBe(true)
  advance(1)
  expect(hintShowing()).toBe(false)
  expect(seenKey()).toBe('true')
})

it('waits on a saved Tasks page and shows when Workspaces first becomes visible', () => {
  seedEligible()
  showRailPage('tasks')
  render(<Harness />)
  advance(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS * 2)
  expect(hintBubble()).toBeNull()
  expect(seenKey()).toBeNull()

  showRailPage('terminal')
  expect(hintShowing()).toBe(true)
})

it('never shows to a first-time user who opens the board and then remounts the sidebar', () => {
  useAppStore.setState({
    persistedUIReady: true,
    featureInteractions: {},
    workspaceBoardUsedBeforeLaunch: false
  })
  const first = render(<Harness />)
  act(() => {
    useAppStore.setState({ featureInteractions: BOARD_USED })
  })
  first.unmount()
  // Collapsing and reopening the sidebar mounts a fresh toolbar that now sees board use.
  render(<Harness />)
  advance(1000)
  expect(hintBubble()).toBeNull()
  expect(seenKey()).toBeNull()
})

it('drops an already-open board label the moment the hint appears', () => {
  windowFocused = false
  seedEligible()
  render(<Harness />)
  hoverBoardButton()
  expect(boardLabel()?.textContent).toBe('Workspace board')

  focusWindow()
  expect(hintShowing()).toBe(true)
  // Unmounted, not fading out: a closing label would still hold its Escape layer.
  expect(boardLabel()).toBeNull()
  expect(pressEscapeOnSibling()).toBe(false)

  // The stale open intent must not bring the label back after the hint, with the pointer gone.
  fireEvent.pointerLeave(boardButton(), { pointerType: 'mouse' })
  advance(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS)
  advance(WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
  expect(hintShowing()).toBe(false)
  expect(boardLabel()).toBeNull()
})

it('ignores a hover that starts just before the hint ends, through its fade-out and after', () => {
  seedEligible()
  render(<Harness />)
  advance(WORKSPACE_BOARD_MOVED_HINT_DURATION_MS - 300)
  fireEvent.pointerMove(boardButton(), { pointerType: 'mouse' })
  // The 600 ms hover delay would end just after the 200 ms fade-out.
  advance(300)
  expect(hintShowing()).toBe(false)
  expect(boardLabel()).toBeNull()
  expect(pressEscapeOnSibling()).toBe(false)
  advance(WORKSPACE_BOARD_MOVED_HINT_EXIT_MS)
  // The pointer is still resting on the button, but that hover began under the hint.
  advance(1000)
  expect(boardLabel()).toBeNull()
  expect(pressEscapeOnSibling()).toBe(false)

  // A fresh pointer move after the hint opens the label as usual.
  hoverBoardButton()
  expect(boardLabel()?.textContent).toBe('Workspace board')
  expect(boardButton().getAttribute('aria-describedby')).toBe(boardLabel()?.id)
})

it('does not show again once seen', () => {
  window.localStorage.setItem(WORKSPACE_BOARD_MOVED_HINT_STORAGE_KEY, 'true')
  seedEligible()
  render(<Harness />)
  expect(hintBubble()).toBeNull()
})
