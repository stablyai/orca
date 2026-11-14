// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../../shared/managed-account-types'
import { useAppStore } from '../../../../store/index'
import { nativeClient, changeSettings } from './ai-vault-account-native-test-fixture'
import { sessionAccountBinding } from './ai-vault-account-binding'
import { readSessionAccount, subscribeSessionAccount } from './ai-vault-account-directory'
import { accountWorkCounters } from './ai-vault-account-work-test-fixture'
import {
  accountSettings,
  recordedSession,
  accountCards,
  flushAccountWork,
  installAccountFixture
} from './ai-vault-account-test-fixture'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
installAccountFixture()

it('drains actual deferred list dispatches through R0, R1, R2, failures and legitimate recovery', async () => {
  const settings = accountSettings()
  useAppStore.setState({ settings })
  const reads: {
    claude: ReturnType<typeof Promise.withResolvers<ClaudeRateLimitAccountsState>>
    codex: ReturnType<typeof Promise.withResolvers<CodexRateLimitAccountsState>>
  }[] = []
  const claudeList = vi.fn(() => {
    const read = {
      claude: Promise.withResolvers<ClaudeRateLimitAccountsState>(),
      codex: Promise.withResolvers<CodexRateLimitAccountsState>()
    }
    reads.push(read)
    return read.claude.promise
  })
  const codexList = vi.fn(() => reads.at(-1)!.codex.promise)
  window.api.claudeAccounts = { ...window.api.claudeAccounts, list: claudeList }
  window.api.codexAccounts = { ...window.api.codexAccounts, list: codexList }
  const a = recordedSession('claude')
  const panel = render(accountCards([a, { ...recordedSession('codex'), id: 'codex' }]))
  const mutate = () =>
    changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a) => ({
        ...a,
        lastAuthenticatedAt: a.lastAuthenticatedAt + 1
      }))
    }))
  const settle = async (n: number, failure: 'none' | 'claude' | 'both' = 'none') =>
    act(async () => {
      const read = reads[n]!
      if (failure === 'none') {
        read.claude.resolve({
          accounts: [
            {
              ...settings.claudeManagedAccounts[0]!,
              home: '/accounts/claude-0',
              email: `R${n}@example.com`
            }
          ],
          activeAccountId: null
        })
      } else {
        read.claude.reject(new Error('Claude unavailable'))
      }
      if (failure === 'both') {
        read.codex.reject(new Error('Codex unavailable'))
      } else {
        read.codex.resolve({
          accounts: [{ ...settings.codexManagedAccounts[0]!, email: `healthy-${n}@example.com` }],
          activeAccountId: null
        })
      }
    })
  expect(reads).toHaveLength(1)
  await mutate()
  expect(reads).toHaveLength(1)
  await settle(0)
  expect(reads).toHaveLength(2)
  expect(panel.getByTestId(a.id).textContent).toContain('Unknown')
  await mutate()
  expect(reads).toHaveLength(2)
  await settle(1, 'both')
  expect(reads).toHaveLength(3)
  await settle(2)
  expect(reads).toHaveLength(3)
  expect(panel.getByTestId(a.id).textContent).toContain('R2@example.com')
  await mutate()
  expect(panel.getByTestId(a.id).textContent).toContain('Unknown')
  await settle(3, 'claude')
  expect(panel.getByTestId('codex').textContent).toContain('healthy-3@example.com')
  expect(reads).toHaveLength(4)
  panel.rerender(
    accountCards([
      a,
      { ...recordedSession('codex'), id: 'codex' },
      { ...recordedSession('codex'), id: 'healthy-provider-recovery' }
    ])
  )
  expect(reads).toHaveLength(5)
  await settle(4, 'both')
  await flushAccountWork()
  expect(reads).toHaveLength(5)
  panel.rerender(
    accountCards([a, { ...a, id: 'recover' }, { ...recordedSession('codex'), id: 'codex' }])
  )
  expect(reads).toHaveLength(6)
  await settle(5)
  expect(panel.getByTestId('recover').textContent).toContain('R5@example.com')
  expect(panel.getByTestId(a.id).textContent).toContain('R5@example.com')
  // Last native reader fences already-dispatched IPC; a later owner starts fresh.
  panel.unmount()
  await flushAccountWork()
  const latePanel = render(accountCards([a]))
  expect(reads).toHaveLength(7)
  latePanel.unmount()
  await flushAccountWork()
  const successor = render(accountCards([a]))
  expect(reads).toHaveLength(8)
  await settle(6)
  expect(successor.getByTestId(a.id).textContent).toContain('Unknown')
  await settle(7)
  expect(successor.getByTestId(a.id).textContent).toContain('R7@example.com')
  expect(claudeList).toHaveBeenCalledTimes(8)
  expect(codexList).toHaveBeenCalledTimes(8)
  successor.unmount()
  await flushAccountWork()
  claudeList.mockImplementationOnce(() => {
    throw new Error('Synchronous IPC setup failure')
  })
  const setupFailure = render(accountCards([a]))
  await flushAccountWork()
  expect(setupFailure.getByTestId(a.id).textContent).toContain('Unknown')
  expect(claudeList).toHaveBeenCalledTimes(9)
  setupFailure.rerender(accountCards([a, { ...a, id: 'after-setup-failure' }]))
  expect(claudeList).toHaveBeenCalledTimes(10)
  await settle(8)
  expect(setupFailure.getByTestId(a.id).textContent).toContain('R8@example.com')
})

it('reactivates the exact held native entry against changed inputs before its cleanup turn', async () => {
  const settings = accountSettings()
  useAppStore.setState({ settings })
  const client = nativeClient(settings)
  const metrics = accountWorkCounters()
  const selected = sessionAccountBinding(recordedSession('claude'))
  if (!('key' in selected)) {
    throw new Error('Missing native binding')
  }
  const old = vi.fn()
  const next = vi.fn()
  const close = subscribeSessionAccount(selected.key, selected.binding, old)
  await flushAccountWork()
  expect(readSessionAccount(selected.key)).toBe('claude-0@example.com')
  client.setClaude({
    accounts: [
      {
        ...settings.claudeManagedAccounts[0]!,
        home: '/accounts/claude-0',
        email: 'reactivated@example.com'
      }
    ],
    activeAccountId: null
  })
  let release = () => {}
  await act(async () => {
    close()
    useAppStore.setState({
      settings: {
        ...settings,
        claudeManagedAccounts: settings.claudeManagedAccounts.map((a) => ({
          ...a,
          lastAuthenticatedAt: 2
        }))
      }
    })
    expect(client.claudeList).toHaveBeenCalledTimes(1)
    release = subscribeSessionAccount(selected.key, selected.binding, next)
    expect(readSessionAccount(selected.key)).toBeNull()
  })
  expect(client.claudeList).toHaveBeenCalledTimes(2)
  expect(readSessionAccount(selected.key)).toBe('reactivated@example.com')
  expect(metrics.settingsListeners()).toBe(1)
  expect(next).toHaveBeenCalledTimes(1)
  release()
  await flushAccountWork()
  expect(metrics.settingsListeners()).toBe(0)
})
