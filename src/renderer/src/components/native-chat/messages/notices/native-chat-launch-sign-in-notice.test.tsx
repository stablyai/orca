// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StructuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { NativeChatComposerNotices } from '../../composer/controls/NativeChatComposerNotices'
import type { NativeChatHostSetup } from '../../host-access/native-chat-host-setup-view'
import { structuredSessionNotices } from './native-chat-structured-session-notices'

const failure: StructuredLaunchFailure = {
  kind: 'refused',
  code: 'agent_session_operation_invalid',
  details: { reason: 'notSignedIn', account: 'system' }
}

function launchNotice(signIn: NativeChatHostSetup['signIn'], retry = vi.fn()) {
  const [notice] = structuredSessionNotices({
    launch: { lifecycle: 'failed', failure, retry },
    agentLabel: 'Codex',
    sessionError: null,
    composerError: null,
    setup: { signIn, install: null }
  })
  return notice
}

afterEach(cleanup)

it('offers only Sign in before any sign-in terminal opened', () => {
  const notice = launchNotice({
    signingIn: false,
    signIn: vi.fn(),
    loginCommand: 'codex login'
  })
  expect(notice?.signIn?.button?.label).toBe('Sign in')
  expect(notice?.action).toBeUndefined()
})

it('keeps the launch Retry beside Sign in once a sign-in could not be confirmed', () => {
  const retry = vi.fn()
  const notice = launchNotice(
    {
      signingIn: false,
      unconfirmed: true,
      signIn: vi.fn(),
      loginCommand: 'codex login'
    },
    retry
  )
  expect(notice?.text).toBe("Codex isn't signed in.")
  expect(notice?.action).toMatchObject({ label: 'Retry' })
  render(
    <TooltipProvider>
      <NativeChatComposerNotices notices={notice ? [notice] : []} />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  screen.getByRole('button', { name: 'Retry' }).click()
  expect(retry).toHaveBeenCalledOnce()
})

it('falls back to the plain launch Retry once the sign-in is confirmed', () => {
  const notice = launchNotice({
    signingIn: false,
    signedIn: true,
    signIn: vi.fn()
  })
  expect(notice?.signIn).toBeUndefined()
  expect(notice?.action).toMatchObject({ label: 'Retry' })
})
