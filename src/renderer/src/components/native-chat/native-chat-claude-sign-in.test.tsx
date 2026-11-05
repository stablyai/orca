// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { useNativeChatClaudeSignIn } from './native-chat-claude-sign-in'

const signInToClaudeAccount = vi.hoisted(() => vi.fn(async (_accountId: string) => true))
vi.mock('@/lib/claude-account-sign-in', () => ({ signInToClaudeAccount }))

afterEach(() => {
  cleanup()
  signInToClaudeAccount.mockClear()
  useAppStore.setState({ repos: [] })
})

const account = (id: string, wslDistro?: string) => ({
  id,
  email: `${id}@example.test`,
  authMethod: 'subscription-oauth' as const,
  managedAuthPath: '/unused',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0,
  ...(wslDistro ? { managedAuthRuntime: 'wsl' as const, wslDistro } : {})
})

function signInFor(claudeAccountId: string): string | undefined {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/dev'),
      claudeManagedAccounts: [account('host-a'), account('host-b'), account('wsl-c', 'Ubuntu')],
      activeClaudeManagedAccountId: 'host-a'
    },
    repos: [
      {
        id: 'work',
        path: '/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        claudeAccountId
      }
    ]
  })
  const { result } = renderHook(() =>
    useNativeChatClaudeSignIn({
      agent: 'claude',
      target: { kind: 'local' },
      worktreeId: 'work::/repo',
      failure: 'notSignedIn',
      failureRows: 1
    })
  )
  act(() => result.current?.signIn())
  return signInToClaudeAccount.mock.calls.at(-1)?.[0]
}

it("signs in the account the project's chat launches on", () => {
  expect(signInFor('host-b')).toBe('host-b')
  // Chats run on host accounts, so a WSL pin leaves this chat on the host selection.
  expect(signInFor('wsl-c')).toBe('host-a')
})
