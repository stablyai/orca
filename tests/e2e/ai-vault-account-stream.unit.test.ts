// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import type { RuntimeRpcResponse } from '../../src/shared/runtime-rpc-envelope'
import { useAppStore } from '@/store'
import { nativeClient } from '@/components/right-sidebar/ai-vault/accounts/ai-vault-account-native-test-fixture'
import type { AiVaultSession } from '../../src/shared/ai-vault/contracts/ai-vault-types'
import { decodeAccountsSnapshot } from '../../mobile/src/components/accounts-snapshot'
import { createRateLimitsApi } from '@/web/preload-api/web-rate-limits-api'
import { accountStreamFixture, P, profile } from './ai-vault-account-stream-test-fixture'
import {
  accountSettings,
  accountCards,
  details,
  recordedSession,
  flushAccountWork,
  installAccountFixture
} from '@/components/right-sidebar/ai-vault/accounts/ai-vault-account-test-fixture'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const bridge = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/web/preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'fixture' }),
  getClientForEnvironment: () => ({ subscribe: bridge.subscribe })
}))
vi.mock('@/web/preload-api/web-runtime-calls', () => ({ callRuntimeResult: vi.fn() }))
installAccountFixture()
let fixture: ReturnType<typeof accountStreamFixture> | undefined
let closeWeb: (() => void) | undefined
afterEach(async () => {
  closeWeb?.()
  closeWeb = undefined
  await fixture?.dispose()
  fixture = undefined
})
function dataSession(id = 'p', profileId = P): AiVaultSession {
  return {
    ...recordedSession('claude'),
    id,
    agent: 'opencode',
    accountHome: { kind: 'opencode', locator: { kind: 'managed', managedProfileId: profileId } }
  }
}

it('isolates real optional-registry failures in ready/data/usage while keeping strict and mobile/web consumers', async () => {
  const source = (fixture = accountStreamFixture())
  fs.writeFileSync(source.registry('devin'), 'corrupt registry')
  const panel = details([dataSession()])
  await flushAccountWork()
  expect(panel.account('p').getByText('Work')).toBeTruthy()
  bridge.subscribe.mockImplementation(
    (
      method: string,
      params: unknown,
      handlers: { onResponse: (response: RuntimeRpcResponse<unknown>) => void }
    ) => source.subscribe({ method, params }, handlers.onResponse)
  )
  const webUsage = vi.fn()
  closeWeb = createRateLimitsApi().onUpdate(webUsage)
  await flushAccountWork()
  const validFrames = () => {
    for (const frame of source.frames) {
      if (typeof frame === 'object' && frame !== null && 'snapshot' in frame) {
        const snapshot = decodeAccountsSnapshot(frame.snapshot)
        expect(snapshot.claude.accounts.map((account) => account.id)).toEqual(['healthy-claude'])
        expect(snapshot.codex.accounts.map((account) => account.id)).toEqual(['healthy-codex'])
        expect(snapshot.devin).toBeUndefined()
      }
    }
  }
  validFrames()
  expect(webUsage).toHaveBeenCalled()
  const beforeUsage = webUsage.mock.calls.length
  await act(async () => source.usage.publish())
  expect(webUsage.mock.calls.length).toBe(beforeUsage + 1)
  expect(webUsage.mock.calls.at(-1)?.[0]).toMatchObject({ codex: { status: 'ok', updatedAt: 1 } })
  await expect(source.callStrict('accounts.list')).rejects.toThrow()
  await expect(source.callStrict('accounts.listData')).rejects.toThrow()
  expect(() => source.controller.getSnapshot()).toThrow()
  await act(async () => {
    await source.controller.removeData('opencode', P)
  })
  panel.unknown('p')
  validFrames()
  // An unavailable used registry is omitted, clears proof and restores on a legitimate event.
  source.seed('opencode', [profile(P, 'Restored')])
  await act(async () => source.usage.publish())
  expect(panel.account('p').getByText('Restored')).toBeTruthy()
  fs.writeFileSync(source.registry('opencode'), 'corrupt registry')
  await act(async () => source.usage.publish())
  panel.unknown('p')
  const last = source.frames.at(-1)
  if (typeof last !== 'object' || last === null || !('snapshot' in last)) {
    throw new Error('Missing actual frame')
  }
  expect(decodeAccountsSnapshot(last.snapshot).opencode).toBeUndefined()
  source.seed('opencode', [profile(P, 'Restored again')])
  await act(async () => source.usage.publish())
  expect(panel.account('p').getByText('Restored again')).toBeTruthy()
  expect(source.counters().listData).toBe(0)
})

it('fences lost streams and late handles, recovers old readers on new acquire, and retains same-commit leases', async () => {
  const source = (fixture = accountStreamFixture())
  source.holdHandles(true)
  const p = dataSession()
  const panel = render(accountCards([p]))
  await flushAccountWork()
  expect(panel.getByTestId('p').textContent).toContain('Work')
  await act(async () => source.slots[0]!.end())
  expect(panel.getByTestId('p').textContent).toContain('Unknown')
  panel.rerender(accountCards([p, dataSession('new')]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(2)
  expect(source.listenerCounts()).toEqual([1, 1])
  expect(panel.getByTestId('p').textContent).toContain('Work')
  await act(async () => {
    source.slots[0]!.releaseHandle()
    source.slots[0]!.emit({
      type: 'snapshot',
      snapshot: { opencode: { accounts: [profile(P, 'Stale')] } }
    })
    source.slots[0]!.emit({ type: 'end' })
  })
  expect(source.slots[0]!.unsubscribe).toHaveBeenCalledTimes(1)
  expect(panel.getByTestId('p').textContent).toContain('Work')
  for (const snapshot of [{}, { opencode: { accounts: [{ id: P, label: 1 }] } }]) {
    await act(async () => source.slots[1]!.emit({ type: 'snapshot', snapshot }))
    expect(panel.getByTestId('p').textContent).toContain('Unknown')
    await act(async () => source.usage.publish())
    expect(panel.getByTestId('p').textContent).toContain('Work')
  }
  // The same-commit new key has the same binding; the pending handle and producer survive.
  panel.rerender(accountCards([dataSession('replacement')]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(2)
  await act(async () => source.slots[1]!.releaseHandle())
  panel.unmount()
  await flushAccountWork()
  expect(source.listenerCounts()).toEqual([0, 0])
  expect(source.slots[1]!.unsubscribe).toHaveBeenCalledTimes(1)
  const reacquired = render(accountCards([p]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(3)
  expect(reacquired.getByTestId('p').textContent).toContain('Work')
  // A rejected source is lost evidence, with no autonomous retry.
  await act(async () => {
    source.slots[2]!.fail()
    source.slots[2]!.releaseHandle()
  })
  source.subscribe.mockRejectedValueOnce(new Error('transport rejected'))
  reacquired.rerender(accountCards([p, dataSession('retry-failed')]))
  await flushAccountWork()
  expect(reacquired.getByTestId('p').textContent).toContain('Unknown')
  expect(source.subscribe).toHaveBeenCalledTimes(4)
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(4)
  reacquired.rerender(accountCards([p, dataSession('retry-failed'), dataSession('recovered')]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(5)
  expect(reacquired.getByTestId('p').textContent).toContain('Work')
  await act(async () => source.slots[3]!.releaseHandle())
  const settings = accountSettings()
  useAppStore.setState({ settings })
  const native = nativeClient(settings)
  let nativeListeners = 0
  const subscribe = useAppStore.subscribe
  vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
    nativeListeners++
    const close = subscribe(listener)
    return () => {
      nativeListeners--
      close()
    }
  })
  const c = recordedSession('claude')
  reacquired.rerender(accountCards([p, c]))
  await flushAccountWork()
  expect(native.claudeList).toHaveBeenCalledTimes(1)
  expect(source.listenerCounts()).toEqual([1, 1])
  expect(nativeListeners).toBe(1)
  // Releasing either domain drops its roots/source independently while the other remains live.
  reacquired.rerender(accountCards([p]))
  await flushAccountWork()
  expect(nativeListeners).toBe(0)
  expect(source.listenerCounts()).toEqual([1, 1])
  reacquired.rerender(accountCards([p, c]))
  await flushAccountWork()
  expect(native.claudeList).toHaveBeenCalledTimes(2)
  reacquired.rerender(accountCards([c]))
  await flushAccountWork()
  expect(source.listenerCounts()).toEqual([0, 0])
  expect(nativeListeners).toBe(1)
  expect(source.slots[3]!.unsubscribe).toHaveBeenCalledTimes(1)
  reacquired.unmount()
  await flushAccountWork()
  expect(nativeListeners).toBe(0)

  // Close before dispatch/ready: the real IPC abort reaches the later admitted handler.
  source.holdHandles(false)
  source.holdDispatch(true)
  const beforeSetup = source.counters()
  const early = render(accountCards([p]))
  await flushAccountWork()
  expect(early.getByTestId('p').textContent).toContain('Unknown')
  early.unmount()
  await flushAccountWork()
  const earlySlot = source.slots.at(-1)!
  expect(earlySlot.unsubscribe).toHaveBeenCalledTimes(1)
  expect(source.transportListeners()).toBe(0)
  await act(async () => earlySlot.releaseDispatch())
  expect(source.counters()).toEqual(beforeSetup)
  expect(source.pendingStreams()).toBe(0)
  expect(source.listenerCounts()).toEqual([0, 0])
  expect(source.subscriptions).toHaveProperty('cleanups.size', 0)

  // Ready can precede a delayed preload handle; retirement closes that exact late handle.
  source.holdDispatch(false)
  source.holdHandles(true)
  const late = render(accountCards([p]))
  await flushAccountWork()
  expect(late.getByTestId('p').textContent).toContain('Work')
  late.unmount()
  await flushAccountWork()
  expect(source.listenerCounts()).toEqual([1, 1])
  await act(async () => source.slots.at(-1)!.releaseHandle())
  expect(source.listenerCounts()).toEqual([0, 0])
  expect(source.pendingStreams()).toBe(0)
  expect(source.transportListeners()).toBe(0)

  // A real ready-construction failure settles dispatch and releases its server registration.
  source.holdHandles(false)
  vi.spyOn(source.runtime, 'getAccountsStreamSnapshot').mockImplementationOnce(() => {
    throw new Error('ready construction failed')
  })
  const failed = render(accountCards([p]))
  await flushAccountWork()
  expect(failed.getByTestId('p').textContent).toContain('Unknown')
  expect(source.listenerCounts()).toEqual([0, 0])
  expect(source.pendingStreams()).toBe(0)
  expect(source.transportListeners()).toBe(0)
  expect(source.subscriptions).toHaveProperty('cleanups.size', 0)
  expect(source.subscriptions).toHaveProperty('cleanupPromises.size', 0)
  failed.unmount()
  await flushAccountWork()
})
