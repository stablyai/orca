// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../pane/ownership/native-chat-view-memory'
import { useManagedClaudeSignIn } from './native-chat-managed-claude-sign-in'

const login = vi.hoisted(() => ({ finish: (_signedIn: boolean): void => {} }))
vi.mock('@/lib/provider-accounts/claude-account-sign-in', () => ({
  signInToClaudeAccount: () =>
    new Promise<boolean>((resolve) => {
      login.finish = resolve
    })
}))

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1', conversation: 'claude:s1' }
const inTab = ({ children }: { children: ReactNode }) => (
  <NativeChatViewTabContext value={TAB}>{children}</NativeChatViewTabContext>
)

beforeEach(() => {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
      [TAB.worktreeId]: [{ id: TAB.tabId } as Tab]
    }
  })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it('a Claude sign-in that finishes while its chat is switched away shows signed in on return', async () => {
  const failure = { kind: 'signedOut' }
  const first = renderHook(() => useManagedClaudeSignIn('account-1', failure, 1), {
    wrapper: inTab
  })
  act(() => first.result.current?.signIn())
  first.unmount()
  await act(async () => {
    login.finish(true)
    await Promise.resolve()
    await Promise.resolve()
  })
  const back = renderHook(() => useManagedClaudeSignIn('account-1', failure, 1), {
    wrapper: inTab
  })
  expect(back.result.current?.signedIn).toBe(true)
  expect(back.result.current?.signingIn).toBe(false)
})
