// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { structuredSessionNotices } from './native-chat-structured-session-notices'

afterEach(cleanup)

it('routes an authenticated-start refusal to sign-in instead of retrying the same launch', () => {
  const signIn = vi.fn()
  const retry = vi.fn()
  render(
    <NativeChatComposerNotices
      notices={structuredSessionNotices({
        launch: {
          lifecycle: 'failed',
          failure: {
            kind: 'refused',
            code: 'agent_session_operation_invalid',
            details: { reason: 'notSignedIn' }
          },
          retry
        },
        agentLabel: 'OMP',
        sessionError: null,
        composerError: null,
        signIn: { signingIn: false, signIn }
      })}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(signIn).toHaveBeenCalledOnce()
  expect(retry).not.toHaveBeenCalled()
})

it.each(['failed', 'visibility-unknown'] as const)(
  'says the create hand-back failure once and keeps Retry for %s',
  (lifecycle) => {
    const retry = vi.fn()
    const message = 'The message is back in the composer.'
    const notices = structuredSessionNotices({
      launch: { lifecycle, failure: null, retry },
      agentLabel: 'Codex',
      sessionError: message,
      composerError: null
    })
    render(<NativeChatComposerNotices notices={notices} />)
    expect(screen.getAllByText(message)).toHaveLength(1)
    expect(screen.queryByText('Chat could not be started.')).toBeNull()
    expect(screen.queryByText('Chat connection could not be confirmed.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  }
)

it('keeps unrelated composer errors beside the hand-back notice', () => {
  render(
    <NativeChatComposerNotices
      notices={structuredSessionNotices({
        launch: { lifecycle: 'failed', failure: null, retry: () => {} },
        agentLabel: 'Codex',
        sessionError: 'The message is back in the composer.',
        composerError: { text: 'Attachment could not be added.', onDismiss: () => {} }
      })}
    />
  )
  expect(screen.getByText('The message is back in the composer.')).toBeTruthy()
  expect(screen.getByText('Attachment could not be added.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})
