// @vitest-environment happy-dom
// Keyboard focus through Load earlier and Retry: pending, success, repeated failure, reader moves.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatOlderHistoryRow } from './NativeChatOlderHistoryRow'

afterEach(cleanup)

type RowState = { autoLoad: boolean; failed: boolean; loading: boolean; complete?: boolean }

function Transcript({ autoLoad, failed, loading, complete = false }: RowState): React.JSX.Element {
  return (
    <div data-native-chat-scroll tabIndex={0} aria-label="Conversation">
      {complete ? null : (
        <NativeChatOlderHistoryRow
          olderHistory={{
            sentinelRef: () => undefined,
            isAutoLoadEnabled: autoLoad,
            loadFailed: failed,
            loadEarlierManually: () => undefined,
            loadEarlier: async () => 'unchanged'
          }}
          loadingEarlier={loading}
        />
      )}
      <input aria-label="Composer" />
    </div>
  )
}

function focusRetry(): HTMLElement {
  const retry = screen.getByRole('button', { name: 'Retry' })
  act(() => retry.focus())
  expect(document.activeElement).toBe(retry)
  return retry
}

const scroller = (): HTMLElement => screen.getByLabelText('Conversation')

it('keeps keyboard focus in the transcript while a retried load is pending, then on success', () => {
  const { rerender } = render(<Transcript autoLoad={false} failed loading={false} />)
  focusRetry()

  // Retry clears the failure and auto-loading takes over: the button gives way to a status line.
  rerender(<Transcript autoLoad failed={false} loading />)
  expect(document.activeElement).toBe(scroller())

  rerender(<Transcript autoLoad failed={false} loading={false} />)
  expect(document.activeElement).toBe(scroller())
})

it('returns focus to Retry when the retried load fails again', () => {
  const { rerender } = render(<Transcript autoLoad={false} failed loading={false} />)
  focusRetry()
  rerender(<Transcript autoLoad failed={false} loading />)
  expect(document.activeElement).toBe(scroller())

  rerender(<Transcript autoLoad={false} failed loading={false} />)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }))
})

it('hands focus from Retry to Load earlier when auto-loading stays off', () => {
  const { rerender } = render(<Transcript autoLoad={false} failed loading={false} />)
  focusRetry()

  rerender(<Transcript autoLoad={false} failed={false} loading />)
  const load = screen.getByRole('button', { name: 'Loading…' })
  expect(document.activeElement).toBe(load)

  // A repeated failure replaces the busy button with Retry, which takes focus.
  rerender(<Transcript autoLoad={false} failed loading={false} />)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }))
})

it('never moves focus once the reader has moved it elsewhere', () => {
  const { rerender } = render(<Transcript autoLoad={false} failed loading={false} />)
  focusRetry()
  rerender(<Transcript autoLoad failed={false} loading />)
  expect(document.activeElement).toBe(scroller())

  const composer = screen.getByLabelText('Composer')
  act(() => composer.focus())
  rerender(<Transcript autoLoad={false} failed loading={false} />)
  expect(document.activeElement).toBe(composer)
})

it('does not take focus for a failure the reader never acted on', () => {
  const { rerender } = render(<Transcript autoLoad failed={false} loading />)
  const composer = screen.getByLabelText('Composer')
  act(() => composer.focus())

  rerender(<Transcript autoLoad={false} failed loading={false} />)
  expect(document.activeElement).toBe(composer)
})

it('returns focus to the transcript when the focused button goes with the finished history', () => {
  const { rerender } = render(<Transcript autoLoad={false} failed={false} loading={false} />)
  const load = screen.getByRole('button', { name: 'Load earlier messages' })
  act(() => load.focus())
  fireEvent.keyDown(load, { key: 'Enter' })

  rerender(<Transcript autoLoad={false} failed={false} loading={false} complete />)
  expect(document.activeElement).toBe(scroller())
})
