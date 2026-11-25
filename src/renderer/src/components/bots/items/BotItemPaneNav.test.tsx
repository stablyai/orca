// @vitest-environment happy-dom

// The pane with its real item view, body and comment box; only the host reads are faked.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemWalkState } from './use-bot-item-walk'

const reads = vi.hoisted(() => vi.fn())
vi.mock('./use-bot-items', () => ({
  showBotItem: reads,
  commentOnBotItem: vi.fn(() => Promise.resolve()),
  setBotItemsStatus: vi.fn()
}))
vi.mock('../BotGroupTranscriptOwner', () => ({ useBotGroupFileContexts: () => new Map() }))
vi.mock('./BotItemActivityList', () => ({ BotItemActivityList: () => null }))
vi.mock('@/lib/keyboard/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { installAppKeyboardRouter } from '@/lib/keyboard/app-keyboard-router'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useAppStore } from '@/store'
import {
  changePrompt,
  promptEditor,
  promptValue
} from '../../native-chat/composer/editor/native-chat-prompt-editor.test-support'
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
const ITEMS = [
  makeTestBotItem(21, { title: 'Fix the share dialog' }),
  makeTestBotItem(22, { title: 'Draft the release notes' }),
  makeTestBotItem(23, { title: 'Retry the help-text build' })
]

beforeAll(() => installAppKeyboardRouter(window))
afterEach(() => {
  cleanup()
  reads.mockReset()
  useAppStore.setState({ keybindings: {} })
})

/** The pane over a three-item walk; `listed` rows seed each item, as the panel's list does. */
function pane(
  start: number,
  {
    listed = true,
    unlisted = '',
    items = ITEMS
  }: { listed?: boolean; unlisted?: string; items?: typeof ITEMS } = {}
): void {
  function Walk(): React.JSX.Element {
    const [index, setIndex] = useState(start)
    const walk: BotItemWalkState = {
      uid: items[index].uid,
      place: { index: index + 1, total: items.length },
      pending: false,
      failed: false,
      canStep: (direction) => index + direction >= 0 && index + direction < items.length,
      open: vi.fn(),
      step: (direction) => setIndex(index + direction),
      retry: vi.fn(),
      markGone: vi.fn(),
      close: vi.fn(() => null)
    }
    return (
      <BotItemPane
        bot={BOT}
        uid={items[index].uid}
        listed={listed && items[index].uid !== unlisted ? items[index] : undefined}
        walk={walk}
        offline={false}
        onBack={vi.fn()}
      />
    )
  }
  render(
    <TooltipProvider>
      <Walk />
      <input aria-label="Elsewhere" />
    </TooltipProvider>
  )
}

const editor = (): HTMLElement => screen.getByRole('textbox', { name: 'Comment' })
const heading = (): string => screen.getByRole('heading', { level: 2 }).textContent ?? ''
// happy-dom reports AltGraph for any Alt press; Chromium doesn't for Option chords.
function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  fireEvent(target, event)
  return event
}

it('steps from the comment box with ⌥⌘↓ / ⌥⌘↑ and keeps typing in the shown item, its draft kept', () => {
  reads.mockReturnValue(new Promise(() => {}))
  pane(1)
  const nextItem = { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true }
  press(screen.getByLabelText('Elsewhere'), nextItem)
  press(editor(), { ...nextItem, repeat: true })
  press(editor(), { ...nextItem, isComposing: true })
  expect(heading()).toContain('Draft the release notes')

  changePrompt(editor(), 'reply to 22')
  press(editor(), nextItem)
  expect(heading()).toContain('Retry the help-text build')
  expect(document.activeElement).toBe(editor())
  expect(promptValue(editor())).toBe('')

  press(editor(), { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, altKey: true })
  expect(heading()).toContain('Draft the release notes')
  expect(document.activeElement).toBe(editor())
  expect(promptValue(editor())).toBe('reply to 22')
  // The caret comes back after the draft, so typing goes on from its end.
  expect(promptEditor(editor()).state.selection.from).toBe(12)
})

it('types a rebound Option chord in the comment box, and steps with it from an arrow', () => {
  reads.mockReturnValue(new Promise(() => {}))
  useAppStore.setState({ keybindings: { 'botItem.next': ['Alt+J'] } })
  pane(0)
  const typed = press(editor(), { key: '∆', code: 'KeyJ', altKey: true })
  expect(typed.defaultPrevented).toBe(false)
  expect(heading()).toContain('Fix the share dialog')

  const next = screen.getByRole('button', { name: 'Next item' })
  next.focus()
  press(next, { key: '∆', code: 'KeyJ', altKey: true })
  expect(heading()).toContain('Draft the release notes')
})

it('keeps focus in an unread item when Retry gives way to "deleted", unless it moved elsewhere', async () => {
  const gone = (): RuntimeRpcCallError =>
    new RuntimeRpcCallError({ id: '1', ok: false, error: { code: 'not_found', message: 'gone' } })
  for (const elsewhere of [false, true]) {
    let fail: (error: unknown) => void = () => {}
    reads.mockRejectedValueOnce(new Error('offline'))
    reads.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
    pane(1, { listed: false })
    const retry = await screen.findByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Retry' })).toBe(retry)
    if (elsewhere) {
      screen.getByLabelText('Elsewhere').focus()
    }
    await act(async () => fail(gone()))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(document.activeElement).toBe(
      elsewhere
        ? screen.getByLabelText('Elsewhere')
        : document.querySelector('[data-bot-item-focus-home]')
    )
    expect(screen.getByRole('button', { name: 'Next item' })).toBeTruthy()
    cleanup()
    reads.mockReset()
  }
})

it('says the shown item once it shows: not the opened one, a late one when it arrives, and the one gone back to', async () => {
  let arrive: (page: unknown) => void = () => {}
  reads.mockImplementation((_bot: unknown, uid: string) =>
    uid === ITEMS[2].uid ? new Promise((resolve) => (arrive = resolve)) : new Promise(() => {})
  )
  pane(1, { unlisted: ITEMS[2].uid })
  const said = (): string => screen.getByRole('status').textContent ?? ''
  expect(heading()).toContain('Draft the release notes')
  expect(said()).toBe('')

  fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
  expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  expect(said()).toBe('')
  await act(async () => arrive({ item: ITEMS[2], events: [] }))
  expect(heading()).toContain('Retry the help-text build')
  expect(said()).toBe('Item 3 of 3: Retry the help-text build')

  fireEvent.click(screen.getByRole('button', { name: 'Previous item' }))
  expect(heading()).toContain('Draft the release notes')
  expect(said()).toBe('Item 2 of 3: Draft the release notes')
})
