// @vitest-environment happy-dom
import { act } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { emptyCodexAccountsState } from '@/runtime/runtime-provider-accounts-client'
import {
  accountSettings,
  recordedSession,
  details,
  flushAccountWork,
  installAccountFixture
} from './ai-vault-account-test-fixture'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
installAccountFixture()

it('requires successful Claude evidence, with Account after Worktree and usable Unknown actions', async () => {
  const settings = accountSettings()
  const saved = settings.claudeManagedAccounts[0]!
  let deferred = Promise.withResolvers<{
    accounts: (typeof saved & { home?: string })[]
    activeAccountId: string | null
  }>()
  const list = vi.fn(() => deferred.promise)
  window.api.claudeAccounts = { ...window.api.claudeAccounts, list }
  window.api.codexAccounts = {
    ...window.api.codexAccounts,
    list: vi.fn(async () => emptyCodexAccountsState())
  }
  useAppStore.setState({ settings })
  const stale = recordedSession('claude')
  const current = {
    ...stale,
    id: 'current',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/profiles/current' }
  }
  const panel = details([
    stale,
    current,
    { ...stale, id: 'old-response', accountHome: undefined },
    { ...stale, id: 'default', accountHome: null }
  ])
  panel.unknown(stale.id)
  panel.unknown('current')
  panel.unknown('old-response')
  expect(panel.account('default').getByText('System default')).toBeTruthy()
  await act(async () =>
    deferred.resolve({
      accounts: [{ ...saved, home: '/profiles/current', email: 'current@example.com' }],
      activeAccountId: 'another'
    })
  )
  panel.unknown(stale.id)
  expect(panel.account('current').getByText('current@example.com')).toBeTruthy()
  for (const outcome of ['partial', 'empty', 'older', 'rejected'] as const) {
    deferred = Promise.withResolvers()
    if (outcome === 'rejected') {
      window.api.codexAccounts.list = vi.fn().mockRejectedValue(new Error('Codex unavailable'))
    }
    await act(async () => {
      const currentSettings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: {
          ...currentSettings,
          claudeManagedAccounts: currentSettings.claudeManagedAccounts.map((account) => ({
            ...account,
            lastAuthenticatedAt: account.lastAuthenticatedAt + 1
          }))
        }
      })
    })
    panel.unknown(stale.id)
    await act(async () => {
      if (outcome === 'partial' || outcome === 'rejected') {
        deferred.reject(new Error('Claude unavailable'))
      } else {
        deferred.resolve({
          accounts: outcome === 'older' ? [{ ...saved, email: 'older@example.com' }] : [],
          activeAccountId: 'another'
        })
      }
    })
    if (outcome === 'older') {
      expect(panel.account(stale.id).getByText('older@example.com')).toBeTruthy()
    } else {
      panel.unknown(stale.id)
    }
  }
  await flushAccountWork()
  expect(list).toHaveBeenCalledTimes(5)
})
