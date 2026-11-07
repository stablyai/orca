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
