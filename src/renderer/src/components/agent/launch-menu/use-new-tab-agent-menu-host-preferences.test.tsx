// @vitest-environment happy-dom
import { rpc, server, status } from './new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

import { projectAgentLaunchSettings } from '../../../../../shared/agent-launch/choices/agent-launch-settings'

import '../../../runtime/agent-launch-settings/agent-launch-settings-transport'
import '../../../runtime/agent-launch-settings/use-host-agent-launch-preferences'
import '../use-agent-launch-picker-inventory'

import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'

it('ignores old reads across host switches, restarts, and re-pairing', async () => {
  const old = Promise.withResolvers<{ settings: typeof server }>()
  rpc.call.mockReturnValueOnce(old.promise)
  const hook = renderHook(
    ({ environmentId }) =>
      useNewTabAgentMenuRows(
        { workspace: { kind: 'folder', runtimeEnvironmentId: environmentId } },
        true,
        { kind: 'runtime', environmentId }
      ),
    { initialProps: { environmentId: 'alpha' } }
  )
  await act(async () => {})
  hook.rerender({ environmentId: 'beta' })
  await act(async () => {})
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  await act(async () =>
    old.resolve({ settings: projectAgentLaunchSettings({ disabledTuiAgents: ['codex'] }) })
  )
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  const restarted = Promise.withResolvers<{ settings: typeof server }>()
  rpc.call.mockReturnValueOnce(restarted.promise)
  act(() =>
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['beta', status('replacement')]])
    })
  )
  expect(hook.result.current.state).toBe('loading')
  await act(async () => {})
  replaceRuntimeEnvironmentRevisions([{ id: 'beta', createdAt: 9 }])
  act(() =>
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['beta', status('replacement')]])
    })
  )
  await act(async () => {})
  await act(async () =>
    restarted.resolve({ settings: projectAgentLaunchSettings({ disabledTuiAgents: ['codex'] }) })
  )
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
})

it('reopens a freshly mounted menu with the last host answer, then revalidates', async () => {
  const first = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  await act(async () => {})
  first.unmount()
  const pending = Promise.withResolvers<{ settings: typeof server }>()
  rpc.call.mockReturnValueOnce(pending.promise)
  const second = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  expect(second.result.current.state === 'settled' && second.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  await act(async () =>
    pending.resolve({ settings: projectAgentLaunchSettings({ defaultTuiAgent: 'claude' }) })
  )
  expect(second.result.current.state === 'settled' && second.result.current.rows[0]?.agent).toBe(
    'claude'
  )
})

it('stops waiting on a stalled host, then applies its late answer', async () => {
  vi.useFakeTimers()
  try {
    const stalled = Promise.withResolvers<{ settings: typeof server }>()
    rpc.call.mockReturnValueOnce(stalled.promise)
    const hook = renderHook(() =>
      useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    )
    expect(hook.result.current.state).toBe('loading')
    await act(async () => vi.advanceTimersByTime(3_000))
    expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
      'claude'
    )
    await act(async () => stalled.resolve({ settings: server }))
    expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
      'codex'
    )
  } finally {
    vi.useRealTimers()
  }
})
