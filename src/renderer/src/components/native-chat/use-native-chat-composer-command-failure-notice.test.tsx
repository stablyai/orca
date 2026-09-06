// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatComposerCommandFailureNotice } from './use-native-chat-composer-command-failure-notice'

const LIVE_FAILURE = 'Message could not be sent to the agent.'
const SUPERSEDED_FAILURE = "Message was not sent: the pane's agent session was replaced first."

/** Mirrors the composer: the notice is real local state, so the precedence
 *  between a live notice and a superseded pane-owned one is observable. */
function renderNotice(props: {
  message: string | null
  superseded?: boolean
  id?: number | null
  clearCommandFailure?: (consumed: { id: number }) => void
}) {
  return renderHook(
    (current: { message: string | null; superseded?: boolean; id?: number | null }) => {
      const [notice, setNotice] = useState<string | null>(null)
      useNativeChatComposerCommandFailureNotice({
        ompRpcChat: {
          commandFailureMessage: current.message,
          commandFailureSuperseded: current.superseded,
          commandFailureId: current.id ?? (current.message ? 1 : null),
          clearCommandFailure: props.clearCommandFailure
        },
        setNotice
      })
      return { notice, setNotice }
    },
    {
      initialProps: { message: props.message, superseded: props.superseded, id: props.id } as {
        message: string | null
        superseded?: boolean
        id?: number | null
      }
    }
  )
}

describe('useNativeChatComposerCommandFailureNotice', () => {
  it('moves a pane-owned command failure into the remounted composer notice', () => {
    const clearCommandFailure = vi.fn()
    const hook = renderNotice({
      message: 'Command /help could not be sent to the agent.',
      clearCommandFailure
    })

    expect(hook.result.current.notice).toBe('Command /help could not be sent to the agent.')
    // Named, not blind: the store clears only while this is still the notice
    // on the row, so a newer failure racing the effect is not erased unread.
    expect(clearCommandFailure).toHaveBeenCalledExactlyOnceWith({ id: 1 })
  })

  it('shows the same command failing twice, which is what the clear buys', () => {
    // The effect keys on the notice occurrence, and every failure of one
    // command builds the identical string. Without clearing the pane-owned
    // message the second failure is not a change and the user is told nothing.
    const message = 'Command /help could not be sent to the agent.'
    const hook = renderNotice({ message, id: 1 })

    // What the store's clear does, observed from this hook's side.
    act(() => {
      hook.result.current.setNotice(null)
    })
    hook.rerender({ message: null, id: null })
    hook.rerender({ message, id: 2 })

    expect(hook.result.current.notice).toBe(message)
  })

  it('re-shows an identical failure that arrived as a new occurrence', () => {
    // Two sends fail the same way while the row is never seen empty in
    // between: same wording, same flag, different occurrence. Keying on the
    // wording alone makes the second failure invisible -- and hands the store
    // a clear that cannot tell which of the two it consumed.
    const message = 'Command /help could not be sent to the agent.'
    const clearCommandFailure = vi.fn()
    const hook = renderNotice({ message, id: 1, clearCommandFailure })
    act(() => {
      hook.result.current.setNotice(null)
    })

    hook.rerender({ message, id: 2 })

    expect(hook.result.current.notice).toBe(message)
    expect(clearCommandFailure.mock.calls).toEqual([[{ id: 1 }], [{ id: 2 }]])
  })

  it('leaves an unrelated notice alone when the pane owns no failure', () => {
    const clearCommandFailure = vi.fn()
    const hook = renderNotice({ message: null, clearCommandFailure })

    act(() => {
      hook.result.current.setNotice('Pasted image is unsupported by this agent.')
    })

    expect(hook.result.current.notice).toBe('Pasted image is unsupported by this agent.')
    expect(clearCommandFailure).not.toHaveBeenCalled()
  })

  it('never displaces a notice already on screen with a superseded one', () => {
    // The precedence the store cannot enforce on its own: a live send that
    // fails while this composer is mounted writes its notice into local state
    // and leaves the durable field null, so a LATER report from an already
    // replaced session sees a free field and writes the rebind wording. Live
    // wins wherever the live notice actually lives.
    const clearCommandFailure = vi.fn()
    const hook = renderNotice({ message: null, clearCommandFailure })
    act(() => {
      hook.result.current.setNotice(LIVE_FAILURE)
    })

    hook.rerender({ message: SUPERSEDED_FAILURE, superseded: true })

    expect(hook.result.current.notice).toBe(LIVE_FAILURE)
    // Consumed anyway: an unread durable notice replays on the next remount.
    expect(clearCommandFailure).toHaveBeenCalledExactlyOnceWith({ id: 1 })
  })

  it('still shows a superseded notice when the composer has nothing on screen', () => {
    const clearCommandFailure = vi.fn()
    const hook = renderNotice({
      message: SUPERSEDED_FAILURE,
      superseded: true,
      clearCommandFailure
    })

    expect(hook.result.current.notice).toBe(SUPERSEDED_FAILURE)
    expect(clearCommandFailure).toHaveBeenCalledExactlyOnceWith({ id: 1 })
  })

  it('lets a live failure replace a notice already on screen', () => {
    // Only the superseded case yields; the live session's own failure is the
    // most relevant thing the composer can say.
    const hook = renderNotice({ message: null })
    act(() => {
      hook.result.current.setNotice('Pasted image is unsupported by this agent.')
    })

    hook.rerender({ message: LIVE_FAILURE, superseded: false })

    expect(hook.result.current.notice).toBe(LIVE_FAILURE)
  })
})
