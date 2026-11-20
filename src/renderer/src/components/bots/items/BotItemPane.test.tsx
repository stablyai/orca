// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installAppKeyboardRouter } from '@/lib/keyboard/app-keyboard-router'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemWalkState } from './use-bot-item-walk'

const keybindings = vi.hoisted(() => {
  const current: Record<string, string[]> = {}
  return { current }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ keybindings: keybindings.current }) }
}))
vi.mock('@/lib/keyboard/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('@/lib/keyboard/useShortcutLabel', () => ({ useShortcutKeyComboDetails: () => [] }))
const typed = vi.hoisted(() => vi.fn())
// Each item's view, by uid: shown (a comment box with the arrows), or still unread (the arrows alone).
const unread = vi.hoisted(() => new Set<string>())
vi.mock('./BotItemView', () => ({ BotItemView: (props: StubProps) => StubView(props) }))

import { BotItemPane } from './BotItemPane'

type StubProps = {
  uid: string
  commentRef?: { current: unknown }
  nav?: React.ReactNode
  onShown?: (item: BotItem) => void
}

function StubView({ uid, commentRef, nav, onShown }: StubProps): React.JSX.Element {
  const shown = !unread.has(uid)
  const editor = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    if (!shown || !commentRef) {
      return
    }
    commentRef.current = {
      focus: () => editor.current?.focus(),
      focusEnd: () => editor.current?.focus(),
      type: typed
    }
    return () => {
      commentRef.current = null
    }
  }, [shown, commentRef])
  useEffect(() => {
    if (shown) {
      onShown?.(makeTestBotItem(0, { uid, title: `Title ${uid}` }))
    }
  }, [shown, uid, onShown])
  return shown ? (
    <div>
      <button type="button">Status {uid}</button>
      <div data-testid="comment-box" data-native-chat-composer-scope="">
        <textarea ref={editor} aria-label={`Comment ${uid}`} />
        {nav}
      </div>
    </div>
  ) : (
    <div data-testid="unread">{nav}</div>
  )
}

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
const UIDS = ['a', 'b', 'c']

beforeAll(() => installAppKeyboardRouter(window))
afterEach(() => {
  cleanup()
  unread.clear()
  keybindings.current = {}
  vi.useRealTimers()
})

type Control = {
  open: (index: number) => void
  redraw: () => void
  setOffline: (offline: boolean) => void
}
/** A Closed page being read for a step: it lands on the next item, or fails. */
type PageRead = { land: () => void; fail: () => void }

function pane({
  start = 1,
  offline = false,
  paged = false
}: { start?: number; offline?: boolean; paged?: boolean } = {}) {
  const onBack = vi.fn()
  const reads: PageRead[] = []
  const control: { current: Control | null } = { current: null }
  function Walk(): React.JSX.Element {
    const [index, setIndex] = useState(start)
    const [isOffline, setOffline] = useState(offline)
    const [pending, setPending] = useState(false)
    const [readFailed, setReadFailed] = useState(false)
    const [, redraw] = useReducer((n: number) => n + 1, 0)
    control.current = { open: setIndex, redraw, setOffline }
    const read = (direction: 1 | -1): void => {
      setPending(true)
      setReadFailed(false)
      void new Promise<boolean>((resolve) =>
        reads.push({ land: () => resolve(true), fail: () => resolve(false) })
      ).then((landed) => {
        setPending(false)
        if (landed) {
          setIndex((at) => at + direction)
        } else {
          setReadFailed(true)
        }
      })
    }
    const walk: BotItemWalkState = {
      uid: UIDS[index],
      place: { index: index + 1, total: UIDS.length },
      pending,
      failed: readFailed,
      canStep: (direction) => !pending && index + direction >= 0 && index + direction < UIDS.length,
      open: vi.fn(),
      step: (direction) => (paged ? read(direction) : setIndex(index + direction)),
      retry: () => {
        if (paged && readFailed) {
          read(1)
        }
      },
      markGone: vi.fn(),
      close: vi.fn(() => null)
    }
    return (
      <BotItemPane bot={BOT} uid={UIDS[index]} walk={walk} offline={isOffline} onBack={onBack} />
    )
  }
  render(
    <TooltipProvider>
      <Walk />
      <input aria-label="Elsewhere" />
    </TooltipProvider>
  )
  return { onBack, reads, control: () => control.current! }
}

const paneRoot = (): HTMLElement => document.querySelector('[data-bot-item-pane]')!
const arrow = (name: 'Next item' | 'Previous item'): HTMLButtonElement =>
  screen.getByRole('button', { name })
const said = (): string => screen.getByRole('status').textContent ?? ''
// happy-dom reports AltGraph for any Alt press; Chromium doesn't for Option or Ctrl+Alt with an arrow.
function chord(target: Element, key: 'ArrowDown' | 'ArrowUp'): void {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key,
    metaKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  fireEvent(target, event)
}

it('puts the place and arrows in the comment box, Previous before Next, and none in the back row', () => {
  pane()
  const group = within(screen.getByTestId('comment-box')).getByRole('group')
  const [previous, next] = within(group).getAllByRole('button')
  expect(previous).toBe(arrow('Previous item'))
  expect(next).toBe(arrow('Next item'))
  expect(
    screen
      .getByRole('button', { name: 'Home' })
      .parentElement?.querySelector('button[data-bot-item-step]')
  ).toBeNull()
})

it('keeps focus on the clicked arrow in the next item, and gives it to the pane at the end', () => {
  pane({ start: 0 })
  fireEvent.click(arrow('Next item'))
  expect(screen.getByLabelText('Comment b')).toBeTruthy()
  expect(document.activeElement).toBe(arrow('Next item'))
  fireEvent.click(arrow('Next item'))
  expect(arrow('Next item').disabled).toBe(true)
  expect(document.activeElement).toBe(paneRoot())
})

it('offline, neither the arrows nor the chord step, and Back still works', () => {
  const { onBack } = pane({ offline: true })
  expect(arrow('Next item').disabled).toBe(true)
  chord(paneRoot(), 'ArrowDown')
  expect(screen.getByLabelText('Comment b')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Home' }))
  expect(onBack).toHaveBeenCalledOnce()
})

it('says the item shown after a change, never the one opened, and the end when pressed past it', () => {
  const { control } = pane({ start: 0 })
  expect(said()).toBe('')
  fireEvent.click(arrow('Next item'))
  expect(said()).toBe('Item 2 of 3: Title b')
  act(() => control().open(0))
  expect(said()).toBe('Item 1 of 3: Title a')
  chord(screen.getByLabelText('Comment a'), 'ArrowUp')
  expect(said()).toBe('First item')
})

it('says an item opened unread once it shows, and the next one even if the opened one never showed', () => {
  unread.add('b')
  const { control } = pane()
  act(() => {
    unread.delete('b')
    control().redraw()
  })
  expect(said()).toBe('')

  cleanup()
  unread.add('b')
  pane()
  fireEvent.click(arrow('Next item'))
  expect(said()).toBe('Item 3 of 3: Title c')
})

it('keeps the arrow focused when an unread item arrives and its arrows move into its comment box', async () => {
  unread.add('c')
  const { control } = pane()
  fireEvent.click(arrow('Next item'))
  expect(
    within(screen.getByTestId('unread')).getByRole('button', { name: 'Previous item' })
  ).toBeTruthy()
  arrow('Previous item').focus()
  await act(async () => {
    unread.delete('c')
    control().redraw()
  })
  expect(document.activeElement).toBe(arrow('Previous item'))
  expect(screen.getByTestId('comment-box').contains(document.activeElement)).toBe(true)
})

it('gives the pane focus when the arrows are replaced while none of them can take it', async () => {
  unread.add('c')
  const { control } = pane()
  fireEvent.click(arrow('Next item'))
  arrow('Previous item').focus()
  await act(async () => {
    unread.delete('c')
    control().setOffline(true)
  })
  expect(arrow('Previous item').disabled).toBe(true)
  expect(document.activeElement).toBe(paneRoot())
})

it('gives the pane focus when a chord from a removed control lands on an unread item', () => {
  unread.add('c')
  pane()
  const status = screen.getByRole('button', { name: 'Status b' })
  status.focus()
  chord(status, 'ArrowDown')
  expect(document.activeElement).toBe(paneRoot())
})

it('marks a page read loading only once it lasts, and clears it when it lands, fails or is retried', async () => {
  vi.useFakeTimers()
  const { reads } = pane({ start: 0, paged: true })
  const label = (): string | null =>
    within(screen.getByTestId('comment-box')).getByRole('group').getAttribute('aria-label')

  // A read that lands quickly never shows loading, not while in flight nor after the delay would have passed.
  const idle = label()
  fireEvent.click(arrow('Next item'))
  act(() => vi.advanceTimersByTime(100))
  expect(label()).toBe(idle)
  await act(async () => reads[0].land())
  const shown = label()
  act(() => vi.advanceTimersByTime(2000))
  expect(label()).toBe(shown)

  // A slow read shows loading, and a failure clears it for the failed-read alert.
  fireEvent.click(arrow('Next item'))
  expect(label()).toBe(shown)
  act(() => vi.advanceTimersByTime(2000))
  const loading = label()
  expect(loading).not.toBe(shown)
  await act(async () => reads[1].fail())
  expect(label()).toBe(shown)
  expect(screen.getByRole('alert')).toBeTruthy()

  // Retry reads again: loading once it lasts, then the item it lands on.
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(label()).toBe(shown)
  act(() => vi.advanceTimersByTime(2000))
  expect(label()).toBe(loading)
  await act(async () => reads[2].land())
  expect(screen.getByLabelText('Comment c')).toBeTruthy()
  expect(label()).not.toBe(loading)
})

it('steps and goes back with chords rebound to Shift+Insert', () => {
  const { onBack } = pane()
  const insert = { key: 'Insert', code: 'Insert', shiftKey: true }
  keybindings.current = { 'botItem.next': ['Shift+Insert'] }
  fireEvent.keyDown(paneRoot(), insert)
  expect(screen.getByLabelText('Comment c')).toBeTruthy()
  keybindings.current = { 'botItem.back': ['Shift+Insert'] }
  fireEvent.keyDown(paneRoot(), insert)
  expect(onBack).toHaveBeenCalledOnce()
})

it('goes back on unclaimed Escape or the Back chord inside the pane', () => {
  const { onBack } = pane()
  const status = screen.getByRole('button', { name: 'Status b' })
  status.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
  fireEvent.keyDown(status, { key: 'Escape' })
  expect(onBack).not.toHaveBeenCalled()
  fireEvent.keyDown(status, { key: 'Escape' })
  expect(onBack).toHaveBeenCalledOnce()

  const back = { key: '[', code: 'BracketLeft', metaKey: true }
  fireEvent.keyDown(screen.getByLabelText('Elsewhere'), back)
  expect(onBack).toHaveBeenCalledOnce()
  fireEvent.keyDown(status, back)
  expect(onBack).toHaveBeenCalledTimes(2)
})

it('sends typing from the arrows and the pane itself to the comment box', () => {
  pane()
  typed.mockClear()
  const next = arrow('Next item')
  next.focus()
  fireEvent.keyDown(next, { key: 'j' })
  expect(typed).toHaveBeenLastCalledWith('j')
  fireEvent.keyDown(paneRoot(), { key: 'k' })
  expect(typed).toHaveBeenLastCalledWith('k')
  fireEvent.keyDown(screen.getByLabelText('Elsewhere'), { key: 'x' })
  expect(typed).toHaveBeenCalledTimes(2)
})
