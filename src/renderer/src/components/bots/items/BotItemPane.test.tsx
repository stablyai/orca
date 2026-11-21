// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installAppKeyboardRouter } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemWalkState } from './use-bot-item-walk'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ keybindings: {} }) } }))
const typed = vi.hoisted(() => vi.fn())
vi.mock('./BotItemView', () => ({
  BotItemView: ({ commentRef }: { commentRef?: { current: unknown } }) => {
    if (commentRef) {
      commentRef.current = { focus: () => {}, type: typed }
    }
    return (
      <div>
        <button type="button">Status</button>
      </div>
    )
  }
}))

import { BotItemPane } from './BotItemPane'

const BOT: Bot = {
  id: 'bot-a',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

beforeAll(() => installAppKeyboardRouter(window))
afterEach(cleanup)

function walk(fields: Partial<BotItemWalkState> = {}): BotItemWalkState {
  return {
    uid: 'b',
    place: { index: 2, total: 3 },
    pending: false,
    failed: false,
    canStep: () => true,
    open: vi.fn(),
    step: vi.fn(),
    retry: vi.fn(),
    markGone: vi.fn(),
    close: vi.fn(() => null),
    ...fields
  }
}

function pane(state: BotItemWalkState, offline = false) {
  const onBack = vi.fn()
  render(
    <TooltipProvider>
      <BotItemPane bot={BOT} uid="b" walk={state} offline={offline} onBack={onBack} />
      <input aria-label="Elsewhere" />
    </TooltipProvider>
  )
  return onBack
}

// Back's default chord on this platform: Cmd+[ on Mac, Alt+Left on Windows and Linux.
function backChord(target: Element): void {
  const init =
    getShortcutPlatform() === 'darwin'
      ? { key: '[', code: 'BracketLeft', metaKey: true }
      : { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }
  fireEvent.keyDown(target, init)
}

it('shows the place and steps with the arrows; ends are disabled', () => {
  const state = walk({ canStep: (direction) => direction === 1 })
  pane(state)
  expect(screen.getByText('2 / 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
  expect(state.step).toHaveBeenCalledWith(1)
  expect(screen.getByRole('button', { name: 'Previous item' }).hasAttribute('disabled')).toBe(true)
})

it('goes back on unclaimed Escape or the Back chord inside the pane', () => {
  const onBack = pane(walk())
  const status = screen.getByRole('button', { name: 'Status' })
  status.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
  fireEvent.keyDown(status, { key: 'Escape' })
  expect(onBack).not.toHaveBeenCalled()
  fireEvent.keyDown(status, { key: 'Escape' })
  expect(onBack).toHaveBeenCalledOnce()

  backChord(screen.getByLabelText('Elsewhere'))
  expect(onBack).toHaveBeenCalledOnce()
  backChord(status)
  expect(onBack).toHaveBeenCalledTimes(2)
})

it('offline, disables the arrows but keeps Back', () => {
  const onBack = pane(walk(), true)
  expect(screen.getByRole('button', { name: 'Next item' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Home' }))
  expect(onBack).toHaveBeenCalledOnce()
})

it('says when the next Closed page failed, with Retry', () => {
  const state = walk({ failed: true })
  pane(state)
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(state.retry).toHaveBeenCalledOnce()
})

it('sends typing from the arrows and the pane itself to the comment box', () => {
  pane(walk())
  typed.mockClear()
  const next = screen.getByRole('button', { name: 'Next item' })
  next.focus()
  fireEvent.keyDown(next, { key: 'j' })
  expect(typed).toHaveBeenLastCalledWith('j')
  fireEvent.keyDown(document.querySelector('[data-bot-item-pane]')!, { key: 'k' })
  expect(typed).toHaveBeenLastCalledWith('k')
  fireEvent.keyDown(screen.getByLabelText('Elsewhere'), { key: 'x' })
  expect(typed).toHaveBeenCalledTimes(2)
})
