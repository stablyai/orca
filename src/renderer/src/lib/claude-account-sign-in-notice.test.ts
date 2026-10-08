// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../shared/managed-account-types'
import {
  mountHook,
  noticeTestStore,
  setNoticeState,
  unmountHooks
} from '../components/terminal-pane/codex-notice-test-harness'
import { useClaudeAccountSignInNotice } from './claude-account-sign-in-notice'

const { toastInfo, toastError } = vi.hoisted(() => ({ toastInfo: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: toastError } }))
vi.mock('@/store', () => import('../components/terminal-pane/codex-notice-test-harness'))

function account(id: string, needsSignIn = false): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...(needsSignIn ? { needsSignIn: true as const } : {})
  }
}

let state: ClaudeRateLimitAccountsState
const list = vi.fn(() => Promise.resolve(state))
const reauthenticate = vi.fn(() => Promise.resolve(state))
const fetchSettings = vi.fn(() => Promise.resolve())

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state = {
    accounts: [account('a', true), account('b', true)],
    activeAccountId: 'b',
    activeAccountIdsByRuntime: { host: 'b', wsl: {} }
  }
  vi.stubGlobal('api', { claudeAccounts: { list, reauthenticate } })
  noticeTestStore.setState(
    {
      claudeAccountSignInNoticeSeen: true,
      markClaudeAccountSignInNoticeSeen: () =>
        noticeTestStore.setState({ claudeAccountSignInNoticeSeen: true }),
      fetchSettings
    },
    true
  )
})

afterEach(() => {
  unmountHooks()
  vi.unstubAllGlobals()
})

describe('useClaudeAccountSignInNotice', () => {
  it('waits for the persisted flag, then shows once with Sign in for the selected account', async () => {
    await mountHook(useClaudeAccountSignInNotice)
    expect(list).not.toHaveBeenCalled()

    await setNoticeState({ claudeAccountSignInNoticeSeen: false })
    await settle()
    expect(noticeTestStore.getState().claudeAccountSignInNoticeSeen).toBe(true)
    expect(toastInfo).toHaveBeenCalledTimes(1)
    const [title, options] = toastInfo.mock.calls[0]
    expect(title).toBe('Finish setting up your Claude accounts')
    expect(options).toMatchObject({
      description: "Sign in to each saved account once and you're ready to switch anytime.",
      duration: Infinity,
      action: { label: 'Sign in to b@example.test' }
    })

    await act(async () => options.action.onClick())
    await settle()
    expect(reauthenticate).toHaveBeenCalledWith({ accountId: 'b' })
    expect(fetchSettings).toHaveBeenCalled()
  })

  it('signs in to the first account needing it when the selected one does not', async () => {
    state.accounts = [account('a'), account('b', true)]
    state.activeAccountIdsByRuntime = { host: 'a', wsl: {} }
    await mountHook(useClaudeAccountSignInNotice)
    await setNoticeState({ claudeAccountSignInNoticeSeen: false })
    await settle()
    await act(async () => toastInfo.mock.calls[0][1].action.onClick())
    await settle()
    expect(reauthenticate).toHaveBeenCalledWith({ accountId: 'b' })
  })

  it('never shows without an account that needs a sign-in, and never asks again', async () => {
    state.accounts = [account('a')]
    await mountHook(useClaudeAccountSignInNotice)
    await setNoticeState({ claudeAccountSignInNoticeSeen: false })
    await settle()
    expect(toastInfo).not.toHaveBeenCalled()
    expect(noticeTestStore.getState().claudeAccountSignInNoticeSeen).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
  })
})
