// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationSwitchNote } from './ConversationSwitchNote'
import {
  conversationSwitchChanged,
  pendingNativeChatCliSwitches
} from '@/lib/pending-conversation-surface-switches'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  pendingNativeChatCliSwitches.clear()
  vi.useRealTimers()
})

const begin = (entry: { direction: 'chat' | 'terminal'; paneKey?: string; sessionId?: string }) =>
  act(() => {
    pendingNativeChatCliSwitches.set(`local\0${entry.paneKey ?? entry.sessionId}`, {
      chatTabId: null,
      workspaceId: 'wt-1',
      executionHostId: 'local',
      agent: 'claude',
      paneKey: entry.paneKey ?? null,
      sessionId: entry.sessionId ?? null,
      direction: entry.direction
    })
    conversationSwitchChanged()
  })
const settle = () =>
  act(() => {
    pendingNativeChatCliSwitches.clear()
    conversationSwitchChanged()
  })

// Brennan 11-01: the switched pane or chat says what is happening until the destination replaces
// it, after the controls' 200 ms delay, and only there.
it('shows on the terminal pane being switched, after the delay, until the switch settles', () => {
  render(
    <>
      <div data-testid="switched">
        <ConversationSwitchNote surface={{ paneKey: 'tab-1:leaf-a' }} />
      </div>
      <div data-testid="sibling">
        <ConversationSwitchNote surface={{ paneKey: 'tab-1:leaf-b' }} />
      </div>
    </>
  )
  begin({ direction: 'chat', paneKey: 'tab-1:leaf-a' })
  expect(screen.queryByRole('status')).toBeNull()
  act(() => {
    vi.advanceTimersByTime(200)
  })
  const note = screen.getByRole('status')
  expect(screen.getByTestId('switched').contains(note)).toBe(true)
  expect(note.textContent).toContain('Switching to Chat UI…')
  expect(note.textContent).toContain(
    "Stopping Claude. The conversation continues here when it's ready."
  )
  settle()
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows on the chat being switched to its terminal', () => {
  render(<ConversationSwitchNote surface={{ sessionId: 'chat-1', tabId: 'chat-tab-1' }} />)
  begin({ direction: 'terminal', sessionId: 'chat-1' })
  act(() => {
    vi.advanceTimersByTime(200)
  })
  expect(screen.getByRole('status').textContent).toContain('Switching to CLI…')
})

it('never shows for a switch that settles within the delay', () => {
  render(<ConversationSwitchNote surface={{ paneKey: 'tab-1:leaf-a' }} />)
  begin({ direction: 'chat', paneKey: 'tab-1:leaf-a' })
  act(() => {
    vi.advanceTimersByTime(150)
  })
  settle()
  act(() => {
    vi.advanceTimersByTime(200)
  })
  expect(screen.queryByRole('status')).toBeNull()
})
