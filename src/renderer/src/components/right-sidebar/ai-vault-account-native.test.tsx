// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { useAppStore } from '../../store'
import { nativeClient, changeSettings } from './ai-vault-account-native-test-fixture'
import { sessionAccountBinding } from './ai-vault-account-binding'
import { readSessionAccount, subscribeSessionAccount } from './ai-vault-account-directory'
import { accountWorkCounters } from './ai-vault-account-work-test-fixture'
import {
  accountSettings,
  recordedSession,
  accountCards,
  accountRenders,
  flushAccountWork,
  installAccountFixture
} from './ai-vault-account-test-fixture'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
installAccountFixture()

it.each([
  { count: 2, size: 100 },
  { count: 20, size: 100 },
  { count: 2, size: 1000 },
  { count: 20, size: 1000 }
])('shares semantic work at K=$count distinct bindings/S=$size', async ({ count, size }) => {
  const settings = accountSettings(size)
  useAppStore.setState({ settings })
  const client = nativeClient(settings)
  const metrics = accountWorkCounters()
  const sessions = Array.from({ length: count }, (_, i) => recordedSession('claude', i))
  const panel = render(accountCards(sessions.slice(0, 1)))
  await flushAccountWork()
  expect(client.claudeList).toHaveBeenCalledTimes(1)
  expect(metrics.settingsListeners()).toBe(1)
  const acquireRest = async () => {
    metrics.reset()
    accountRenders.clear()
    for (let i = 2; i <= count; i++) {
      panel.rerender(accountCards(sessions.slice(0, i)))
      await flushAccountWork()
      expect(panel.getByTestId(sessions[i - 1]!.id).textContent).toContain(
        `claude-${i - 1}@example.com`
      )
    }
    expect(metrics.work.resolutions).toBe(count - 1)
    expect(metrics.work.savedMembers).toBe(0)
    expect(metrics.work.topologyEncodedBytes).toBe(0)
    expect(metrics.work.displayMembers).toBe(0)
    expect(metrics.work.comparedMembers).toBeLessThanOrEqual(4 * count)
    expect(metrics.work.selected).toBeLessThanOrEqual(2 * count)
    expect(metrics.work.notifications).toBe(0)
    expect(accountRenders.get(sessions[0]!.id) ?? 0).toBe(0)
    expect(client.claudeList).toHaveBeenCalledTimes(1)
    expect(client.codexList).toHaveBeenCalledTimes(1)
  }
  await acquireRest()
  const unused = (s: typeof settings) => ({
    ...s,
    claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
      i === size - 1 ? { ...a, email: 'unused@example.com', lastAuthenticatedAt: 20 } : a
    )
  })
  const quiet = async (update: Parameters<typeof changeSettings>[0], builds: number) => {
    metrics.reset()
    accountRenders.clear()
    await changeSettings(update)
    expect(metrics.work.settingsCallbacks).toBe(1)
    expect(client.claudeList).toHaveBeenCalledTimes(1)
    expect(client.codexList).toHaveBeenCalledTimes(1)
    expect(metrics.work.savedMembers).toBe(builds)
    expect(metrics.work.topologyEncodedBytes).toBeLessThanOrEqual(80 * builds)
    // These count actual proxy member accesses/consumed string bytes inside shared equality.
    expect(metrics.work.comparedMembers).toBeLessThanOrEqual(4 * size + 8 * count)
    expect(metrics.work.comparedBytes).toBeLessThanOrEqual(400 * size + 1200 * count)
    expect(metrics.work.selected).toBeLessThanOrEqual(2 * count)
    expect(metrics.work.resolutions).toBe(0)
    expect(metrics.work.helpers).toBe(0)
    expect(metrics.work.notifications).toBe(0)
    expect(accountRenders.size).toBe(0)
  }
  await quiet((s) => ({ ...s, terminalFontSize: s.terminalFontSize + 1 }), 0)
  expect(metrics.work.comparisons).toBe(0)
  await quiet((s) => ({ ...s, activeClaudeManagedAccountId: 'claude-99' }), 0)
  await quiet(
    (s) => ({
      ...s,
      codexManagedAccounts: s.codexManagedAccounts.map((a) => ({
        ...a,
        email: 'other@example.com'
      }))
    }),
    size
  )
  expect(metrics.work.comparedMembers).toBe(0)
  expect(metrics.work.comparisons).toBe(0)
  // Only A is active when B arrives: the following new keys have no warmed per-key comparison.
  panel.rerender(accountCards(sessions.slice(0, 1)))
  await flushAccountWork()
  await quiet(unused, size)
  await acquireRest()
  await quiet(
    (s) => ({ ...s, claudeManagedAccounts: settings.claudeManagedAccounts.map((a) => ({ ...a })) }),
    size
  )
  // A -> unused B -> recreated A still proves A, including newly acquired covered keys.
  expect(panel.getByTestId(sessions[0]!.id).textContent).toContain('claude-0@example.com')
  await quiet(
    (s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a) => ({ ...a, updatedAt: 25 }))
    }),
    size
  )
  await quiet(
    (s) => ({
      ...s,
      claudeManagedAccounts: [
        ...s.claudeManagedAccounts,
        {
          ...s.claudeManagedAccounts[0]!,
          id: 'distro',
          managedAuthRuntime: 'wsl',
          wslDistro: 'Debian'
        }
      ]
    }),
    size + 1
  )
  metrics.reset()
  accountRenders.clear()
  await act(async () =>
    useAppStore.setState((state) => {
      const statuses = new Map(state.runtimeStatusByEnvironmentId)
      statuses.set('runtime:other', { status: null, checkedAt: 2 })
      return { runtimeStatusByEnvironmentId: statuses }
    })
  )
  expect(metrics.work.selected).toBe(0)
  expect(accountRenders.size).toBe(0)
  await quiet(unused, size + 1)
  // A formerly unused changed binding is not covered by its old native evidence.
  client.setClaude({
    accounts: settings.claudeManagedAccounts.map((a, i) => ({
      ...a,
      home: a.managedAuthPath,
      email: i === size - 1 ? 'unused@example.com' : a.email
    })),
    activeAccountId: null
  })
  const b = recordedSession('claude', size - 1)
  panel.rerender(accountCards([...sessions, b]))
  await flushAccountWork()
  expect(client.claudeList).toHaveBeenCalledTimes(2)
  expect(panel.getByTestId(b.id).textContent).toContain('unused@example.com')
  client.setClaude({
    accounts: [
      { ...settings.claudeManagedAccounts[0]!, home: '/new/home', email: 'current@example.com' }
    ],
    activeAccountId: null
  })
  const discovered = {
    ...sessions[0]!,
    id: 'discover',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/new/home' }
  }
  panel.rerender(accountCards([...sessions, b, discovered]))
  await flushAccountWork()
  expect(panel.getByTestId('discover').textContent).toContain('Unknown')
  await changeSettings((s) => ({
    ...s,
    claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
      i === 0 ? { ...a, managedAuthPath: '/new/home', lastAuthenticatedAt: 30 } : a
    )
  }))
  expect(panel.getByTestId('discover').textContent).toContain('current@example.com')
  expect(panel.getByTestId(sessions[0]!.id).textContent).toContain('Unknown')
  client.setClaude({ accounts: [], activeAccountId: null })
  await changeSettings((s) => ({
    ...s,
    claudeManagedAccounts: s.claudeManagedAccounts.filter((a) => a.id !== 'claude-0')
  }))
  expect(panel.getByTestId('discover').textContent).toContain('Unknown')
  const unknownCodex = {
    ...recordedSession('codex'),
    id: 'unknown-codex',
    accountHome: { variable: 'CODEX_HOME', path: '/new/codex' }
  }
  panel.rerender(accountCards([unknownCodex]))
  await flushAccountWork()
  expect(panel.getByTestId('unknown-codex').textContent).toContain('Unknown')
  const added = {
    ...settings.codexManagedAccounts[0]!,
    id: 'new-codex',
    managedHomePath: '/new/codex',
    email: 'new@example.com'
  }
  client.setCodex({ accounts: [added], activeAccountId: null })
  const beforeDiscovery = client.codexList.mock.calls.length
  await changeSettings((s) => ({ ...s, codexManagedAccounts: [...s.codexManagedAccounts, added] }))
  expect(client.codexList).toHaveBeenCalledTimes(beforeDiscovery + 1)
  expect(panel.getByTestId('unknown-codex').textContent).toContain('new@example.com')
  panel.unmount()
  await flushAccountWork()
  expect(metrics.settingsListeners()).toBe(0)
})

it.each([2, 20])('shares a single binding independently of %i duplicate readers', async (count) => {
  const settings = accountSettings(100)
  useAppStore.setState({ settings })
  const client = nativeClient(settings)
  const metrics = accountWorkCounters()
  const a = recordedSession('claude')
  const sessions = Array.from({ length: count }, (_, i) => ({ ...a, id: `reader-${i}` }))
  const panel = render(
    accountCards([...sessions, { ...a, id: 'remote', executionHostId: 'runtime:other' }])
  )
  await flushAccountWork()
  expect(metrics.work.resolutions).toBe(2)
  expect(client.claudeList).toHaveBeenCalledTimes(1)
  metrics.reset()
  accountRenders.clear()
  client.setClaude({
    accounts: [
      {
        ...settings.claudeManagedAccounts[0]!,
        home: '/accounts/claude-0',
        email: 'changed@example.com'
      }
    ],
    activeAccountId: null
  })
  await changeSettings((s) => ({
    ...s,
    claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
      i === 0 ? { ...a, lastAuthenticatedAt: 2 } : a
    )
  }))
  expect(metrics.work.resolutions).toBe(2)
  expect(metrics.work.notifications).toBe(2 * count)
  expect(accountRenders.get('remote') ?? 0).toBe(0)
  expect(panel.getByTestId('reader-0').textContent).toContain('changed@example.com')
  expect(client.claudeList).toHaveBeenCalledTimes(2)
})

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

it('retains Codex saved fallback and refreshes relevant same-email peer groups', async () => {
  const settings = accountSettings(2)
  settings.codexManagedAccounts[1]!.email = settings.codexManagedAccounts[0]!.email
  useAppStore.setState({ settings })
  const client = nativeClient(settings)
  client.codexList.mockRejectedValueOnce(new Error('Codex unavailable'))
  const a = recordedSession('codex')
  const panel = render(accountCards([a]))
  await flushAccountWork()
  expect(panel.getByTestId(a.id).textContent).toContain('codex-0@example.com')
  client.setCodex({ accounts: settings.codexManagedAccounts, activeAccountId: 'codex-1' })
  await changeSettings((s) => ({
    ...s,
    codexManagedAccounts: s.codexManagedAccounts.map((a, i) =>
      i === 1 ? { ...a, workspaceLabel: 'Team' } : a
    )
  }))
  expect(client.codexList).toHaveBeenCalledTimes(2)
  expect(panel.getByTestId(a.id).textContent).toContain('(codex-0)')
  client.setCodex({ accounts: [{ ...settings.codexManagedAccounts[0]! }], activeAccountId: null })
  await changeSettings((s) => ({
    ...s,
    codexManagedAccounts: s.codexManagedAccounts.filter((a) => a.id !== 'codex-1')
  }))
  expect(panel.getByTestId(a.id).textContent).toContain('codex-0@example.com')
  expect(panel.getByTestId(a.id).textContent).not.toContain('(codex-0)')
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
