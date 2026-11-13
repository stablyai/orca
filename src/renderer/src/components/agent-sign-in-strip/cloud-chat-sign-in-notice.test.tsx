// @vitest-environment happy-dom
// CHAT-BANNERS B2: on an Orca Cloud chat, the agent's "not signed in" card points at the strip's
// Renew, not at the CLI's login and its terminal Sign in button. Elsewhere the card is unchanged.
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { NativeChatHostSetupContext } from '../native-chat/host-access/native-chat-host-setup'
import { NativeChatNoticeRow } from '../native-chat/messages/notices/NativeChatNoticeRow'
import { CloudChatHostProvider, cloudChatSignInContent } from './cloud-chat-sign-in-notice'

const cloud = vi.hoisted(() => ({ on: true }))
vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => cloud.on
}))

afterEach(() => cleanup())

const signIn = { signIn: vi.fn(), pending: false, failureKinds: ['notSignedIn'] }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only signIn's action fields.
const SETUP = { signIn: signIn as never, install: null }

function card(agentName: string) {
  const fact = agentSessionFailureFact('notSignedIn', { account: 'system' })
  return render(
    <CloudChatHostProvider target={{ kind: 'environment', environmentId: 'env-1' }}>
      <NativeChatHostSetupContext.Provider value={SETUP}>
        <NativeChatNoticeRow
          agentName={agentName}
          block={{
            type: 'text',
            tone: 'failure',
            ...agentSessionFailureWords(fact, { agentName, surface: 'row' })
          }}
        />
      </NativeChatHostSetupContext.Provider>
    </CloudChatHostProvider>
  )
}

describe('the not-signed-in card on an Orca Cloud chat', () => {
  it('says Renew above, with no CLI login advice and no Sign in button', () => {
    cloud.on = true
    card('Claude')
    expect(screen.getByText(/Renew it above, then send your message again/)).toBeInTheDocument()
    expect(screen.queryByText(/claude auth login/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('off Orca Cloud the card keeps its own words', () => {
    cloud.on = false
    card('Claude')
    expect(screen.queryByText(/Renew it above/)).toBeNull()
    expect(screen.getByText(/claude auth login/)).toBeInTheDocument()
  })
})

describe('cloudChatSignInContent', () => {
  it('only for Claude or Codex not-signed-in on Orca Cloud', () => {
    expect(cloudChatSignInContent(true, 'notSignedIn', 'Codex')).toMatch(/Your Codex sign-in/)
    expect(cloudChatSignInContent(false, 'notSignedIn', 'Claude')).toBeUndefined()
    expect(cloudChatSignInContent(true, 'usageLimitReached', 'Claude')).toBeUndefined()
    expect(cloudChatSignInContent(true, 'notSignedIn', 'Antigravity')).toBeUndefined()
  })
})
