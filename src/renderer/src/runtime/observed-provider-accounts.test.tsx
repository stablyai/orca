// @vitest-environment happy-dom
import type * as OriginalModule0 from '../../../shared/app-environment'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useProviderAccountList } from '@/components/status-bar/use-provider-account-list'
import { accountHost, accountTransport } from './provider-account-observation.test-fixture'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState
} from './runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

vi.mock('../../../shared/app-environment', async (original) => ({
  ...(await original<typeof OriginalModule0>()),
  hasAppEnvironment: () => false
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const target = { kind: 'environment', environmentId: 'a' } as const

it.each([10, 100])(
  'shares real account producers and isolates provider answers for %s consumers',
  async (count) => {
    const a = accountHost(),
      b = accountHost()
    const transport = accountTransport({ a, b })
    let renders = 0
    let codexRenders = 0
    let codexState: ReturnType<typeof useProviderAccountList<'codex'>>
    function CodexReader() {
      codexState = useProviderAccountList('codex', target, '', emptyCodexAccountsState(), true)
      codexRenders += 1
      return null
    }
    const readerIds = Array.from({ length: count }, (_, id) => id)
    const states: ReturnType<typeof useProviderAccountList<'claude'>>[] = []
    function Reader({ id, owner = target }: { id: number; owner?: RuntimeClientTarget }) {
      const value = useProviderAccountList('claude', owner, '', emptyClaudeAccountsState(), true)
      states[id] = value
      if (owner === target) {
        renders += 1
      }
      return null
    }
    const view = render(
      <>
        <CodexReader />
        {readerIds.map((id) => (
          <Reader key={id} id={id} />
        ))}
        <Reader id={count} owner={{ kind: 'environment', environmentId: 'b' }} />
      </>
    )
    await act(async () => {})
    expect(transport.subscribe).toHaveBeenCalledTimes(2)
    expect(a.listeners.size).toBe(1)
    expect(b.listeners.size).toBe(1)
    transport.reset()
    renders = 0
    codexRenders = 0
    await act(async () => a.emit())
    const comparisonReads = transport.projectionReads
    expect(comparisonReads).toBeGreaterThan(0)
    expect(comparisonReads).toBeLessThanOrEqual(2)
    expect(a.claudeList).toHaveBeenCalledTimes(1)
    expect(a.codexList).toHaveBeenCalledTimes(1)
    expect(renders).toBe(0)
    a.snapshot.codex = { ...a.snapshot.codex, activeAccountId: 'codex-changed' }
    transport.reset()
    await act(async () => a.emit())
    expect(transport.projectionReads).toBe(comparisonReads)
    expect(a.claudeList).toHaveBeenCalledTimes(1)
    expect(a.codexList).toHaveBeenCalledTimes(1)
    expect(renders).toBe(0)
    expect(codexRenders).toBe(1)
    expect(codexState!.accounts.activeAccountId).toBe('codex-changed')
    await act(async () => b.emit())
    expect(renders).toBe(0)
    a.snapshot.claude.activeAccountIdsByRuntime = { host: 'a', wsl: { Debian: null, Ubuntu: null } }
    await act(async () => a.emit())
    expect(renders).toBe(0)
    a.snapshot.claude.accounts[1] = {
      ...a.snapshot.claude.accounts[1]!,
      needsSignIn: true,
      home: '/new-home',
      runsOnSystemDefault: true
    }
    await act(async () => a.emit())
    expect(renders).toBe(count)
    expect(states[0].accounts.accounts[1]).toMatchObject({ needsSignIn: true, home: '/new-home' })
    const source = transport.streams[0]
    await act(async () => source.send({ ...a.snapshot, failedProviders: ['claude'] }))
    expect(states[0].accountsLoaded).toBe(false)
    expect(codexState!.accountsLoaded).toBe(true)
    expect(states[0].accounts.accounts[1].needsSignIn).toBe(true)
    await act(async () => source.send({ ...a.snapshot, failedProviders: ['codex'] }))
    expect(states[0].accountsLoaded).toBe(true)
    view.rerender(
      <>
        <CodexReader />
        {readerIds.slice(1).map((id) => (
          <Reader key={id} id={id} />
        ))}
        <Reader id={count} owner={{ kind: 'environment', environmentId: 'b' }} />
      </>
    )
    expect(a.listeners.size).toBe(1)
    expect(transport.streams[0].close).not.toHaveBeenCalled()
    view.unmount()
    await act(async () => {})
    expect(a.listeners.size).toBe(0)
    expect(b.listeners.size).toBe(0)
    expect(transport.streams.every((stream) => stream.close.mock.calls.length === 1)).toBe(true)
  }
)

it('keeps timeout/error loss separate from equal healthy answers and fences retired owner work', async () => {
  vi.useFakeTimers()
  const a = accountHost(),
    b = accountHost()
  const transport = accountTransport({ a, b }, false)
  let current: ReturnType<typeof useProviderAccountList<'claude'>>
  function Reader({ owner }: { owner: RuntimeClientTarget }) {
    current = useProviderAccountList('claude', owner, '', emptyClaudeAccountsState(), true)
    return null
  }
  const view = render(<Reader owner={target} />)
  await act(async () => {})
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(current!.accountsLoaded).toBe(false)
  expect(transport.streams[0].close).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  await act(async () => transport.streams[0].send(a.snapshot))
  expect(current!.accountsLoaded).toBe(true)
  await act(async () =>
    transport.streams[0].callbacks.onError({ code: 'TEST', message: 'offline' })
  )
  expect(current!.accountsLoaded).toBe(false)
  await act(async () => transport.streams[0].send(a.snapshot))
  expect(current!.accountsLoaded).toBe(true)
  await act(async () => transport.streams[0].callbacks.onClose())
  expect(current!.accountsLoaded).toBe(false)
  await act(async () => transport.streams[0].send(a.snapshot))
  const oldSetter = current!.setAccounts
  const reload = current!.loadAccounts()
  const pendingRead = transport.streams.at(-1)!
  view.rerender(<Reader owner={{ kind: 'environment', environmentId: 'b' }} />)
  await act(async () => transport.streams.at(-1)!.send(b.snapshot))
  await act(async () => {
    pendingRead.send({ ...a.snapshot, claude: { ...a.snapshot.claude, activeAccountId: 'late-a' } })
    await reload
    oldSetter({ ...a.snapshot.claude, activeAccountId: 'old-mutation' })
  })
  expect(current!.accounts.activeAccountId).toBe('a')
  view.unmount()
  const second = render(<Reader owner={target} />)
  expect(current!.accountsLoaded).toBe(false)
  transport.streams[0].send(a.snapshot)
  expect(current!.accountsLoaded).toBe(false)
  await act(async () => transport.streams.at(-1)!.send(a.snapshot))
  expect(current!.accountsLoaded).toBe(true)
  second.unmount()
  const beforeHandle = render(<Reader owner={target} />)
  transport.streams.at(-1)!.callbacks.onClose()
  expect(current!.accountsLoaded).toBe(false)
  beforeHandle.unmount()
  await act(async () => {})
  expect(transport.streams.every((stream) => stream.close.mock.calls.length === 1)).toBe(true)
})
