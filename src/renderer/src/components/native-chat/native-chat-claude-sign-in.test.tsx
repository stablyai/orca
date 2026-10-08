// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentSessionRefusalReason } from '../../../../shared/agent-session-refusal-details'
import { useAppStore } from '@/store'
import { MessageRow } from './NativeChatMessageRow'
import {
  NativeChatClaudeSignInContext,
  useNativeChatClaudeSignIn,
  type NativeChatClaudeSignIn
} from './native-chat-claude-sign-in'
import { structuredSessionNotices } from './native-chat-structured-session-notices'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const reauthenticate = vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: 'a' }))
const LOCAL = { kind: 'local' } as const
const ROW_SIGN_IN = { signingIn: false, signIn: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/me'), activeClaudeManagedAccountId: 'a' },
    fetchSettings: vi.fn(() => Promise.resolve())
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { claudeAccounts: { reauthenticate } }
  })
})
afterEach(cleanup)

function launchNotice(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  claudeSignIn: NativeChatClaudeSignIn | null
) {
  return structuredSessionNotices({
    launch: {
      lifecycle: 'failed',
      failure: { kind: 'refused', code: 'agent_session_operation_invalid', details: { reason } },
      retry: vi.fn()
    },
    agentLabel: 'Claude',
    sessionError: null,
    composerError: null,
    claudeSignIn
  })[0]
}

describe('a Claude chat that failed for want of a sign-in', () => {
  it('offers Sign in on the start failure, then Retry once signed in', async () => {
    const failure = {}
    const { result, rerender } = renderHook(
      (rows: number) =>
        useNativeChatClaudeSignIn({ agent: 'claude', target: LOCAL, failure, failureRows: rows }),
      { initialProps: 0 }
    )
    const notice = launchNotice('notSignedIn', result.current)
    expect(notice?.text).toContain('Claude is not signed in for the selected account.')
    expect(notice?.action?.label).toBe('Sign in')
    await act(async () => notice?.action?.onClick())
    expect(reauthenticate).toHaveBeenCalledWith({ accountId: 'a' })
    expect(result.current).toBeNull()
    expect(launchNotice('notSignedIn', result.current)?.action?.label).toBe('Retry')
    // A new failure after the sign-in offers it again.
    rerender(1)
    expect(result.current).not.toBeNull()
  })

  it('offers Sign in for a missing account folder, and Retry for any other failure', () => {
    const signIn = { signingIn: false, signIn: vi.fn() }
    expect(launchNotice('claudeAccountFolderMissing', signIn)?.action?.label).toBe('Sign in')
    expect(launchNotice('claudeAccountSetupFailed', signIn)?.action?.label).toBe('Retry')
  })

  it('offers nothing for Codex, a remote chat, or System default', () => {
    const args = { target: LOCAL, failure: null, failureRows: 0 }
    expect(
      renderHook(() => useNativeChatClaudeSignIn({ ...args, agent: 'codex' })).result.current
    ).toBeNull()
    const remote = { kind: 'environment', environmentId: 'env-1' } as const
    expect(
      renderHook(() => useNativeChatClaudeSignIn({ ...args, agent: 'claude', target: remote }))
        .result.current
    ).toBeNull()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/me'), activeClaudeManagedAccountId: null }
    })
    expect(
      renderHook(() => useNativeChatClaudeSignIn({ ...args, agent: 'claude' })).result.current
    ).toBeNull()
  })

  it('puts Sign in on the transcript row that says so', () => {
    const body: AgentJournalStatusItem = {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords({ kind: 'notSignedIn' }, { surface: 'row', provider: 'claude' })
    }
    const [message] = projectStructuredItemsToNativeChat([
      { itemId: 'start-failure', sequence: 1, revision: 1, observedAt: 1, body }
    ])
    render(
      <NativeChatClaudeSignInContext.Provider value={ROW_SIGN_IN}>
        <MessageRow message={message!} expandSignal={false} onScrollMessageToTop={vi.fn()} />
      </NativeChatClaudeSignInContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(ROW_SIGN_IN.signIn).toHaveBeenCalled()
  })
})
