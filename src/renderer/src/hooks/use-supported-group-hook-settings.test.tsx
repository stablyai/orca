// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../components/settings/__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store'
import { createProjectGroup } from '../../../shared/project-groups'
import { PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY } from '../../../shared/worktree-runtime-capabilities'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { useSupportedGroupHookSettings } from './use-supported-group-hook-settings'
import {
  replaceRuntimeEnvironmentRevisions,
  getRuntimeEnvironmentRevision
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'

afterEach(() => replaceRuntimeEnvironmentRevisions([]))

function publishContact(environmentId: string, status: RuntimeStatus | null, sequence: number) {
  useAppStore.getState().setRuntimeEnvironmentStatus(environmentId, {
    status,
    checkedAt: sequence,
    snapshot: {
      environmentId,
      pairingRevision: getRuntimeEnvironmentRevision(environmentId) ?? 1,
      sequence,
      checkedAt: sequence,
      status,
      verification: status ? 'verified' : 'unavailable',
      transport: status ? 'ready' : 'disconnected'
    }
  })
}

it('ignores a removed owner reply and waits for replacement contact after a failed probe', async () => {
  clearRuntimeCompatibilityCache()
  replaceRuntimeEnvironmentRevisions([
    { id: 'changing', createdAt: 1, pairingRevision: 1 },
    { id: 'replacement', createdAt: 1, pairingRevision: 1 }
  ])
  const group = {
    ...createProjectGroup({
      name: 'Changing',
      parentPath: '/changing',
      createdFrom: 'manual',
      tabOrder: 0
    }),
    executionHostId: 'runtime:changing' as const
  }
  let oldReply!: (response: ReturnType<typeof createCompatibleRuntimeStatusResponse>) => void
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldReply = resolve
        })
    )
    .mockRejectedValueOnce(new Error('replacement unavailable'))
    .mockImplementation(async () => createCompatibleRuntimeStatusResponse('replacement'))
  Object.defineProperty(window.api, 'runtimeEnvironments', { configurable: true, value: { call } })
  act(() => useAppStore.setState({ projectGroups: [group] }))
  const view = renderHook(() => useSupportedGroupHookSettings())
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  await act(async () => {
    useAppStore.setState({
      projectGroups: [{ ...group, executionHostId: 'runtime:replacement' }]
    })
  })
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  await act(async () => {
    oldReply(createCompatibleRuntimeStatusResponse('old-owner'))
  })
  expect(view.result.current).toEqual([])
  await act(async () => {
    publishContact('replacement', createCompatibleRuntimeStatusResponse('replacement').result, 1)
  })
  await waitFor(() => expect(view.result.current[0]?.supportsArchiveHooks).toBe(true))
  view.unmount()
  replaceRuntimeEnvironmentRevisions([])
})

it('ignores the old pairing reply after a host is replaced', async () => {
  clearRuntimeCompatibilityCache()
  const changing = publicRuntimeEnvironment({ id: 'changing', pairingRevision: 1 })
  const quiet = publicRuntimeEnvironment({ id: 'quiet', pairingRevision: 1 })
  const replies: ((response: ReturnType<typeof createCompatibleRuntimeStatusResponse>) => void)[] =
    []
  const call = vi.fn(({ selector }: { selector: string }) =>
    selector === 'quiet'
      ? Promise.resolve(createCompatibleRuntimeStatusResponse('quiet'))
      : new Promise<ReturnType<typeof createCompatibleRuntimeStatusResponse>>((resolve) => {
          replies.push(resolve)
        })
  )
  const projectGroups = Array.from({ length: 2 }, (_, i) => ({
    ...createProjectGroup({
      name: `Group ${i}`,
      parentPath: `/groups/${i}`,
      createdFrom: 'manual',
      tabOrder: i
    }),
    executionHostId: i % 2 === 0 ? 'runtime:changing' : 'runtime:quiet'
  }))
  Object.defineProperty(window.api, 'runtimeEnvironments', {
    configurable: true,
    value: { call }
  })
  act(() => {
    useAppStore.setState({
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      projectGroups
    })
    useAppStore.getState().setRuntimeEnvironments([changing, quiet])
  })
  const view = renderHook(() => useSupportedGroupHookSettings())
  await waitFor(() => expect(view.result.current).toHaveLength(1))
  await act(async () => {
    useAppStore.getState().setRuntimeEnvironments([{ ...changing, pairingRevision: 2 }, quiet])
    // The replacement catalog can republish the same group rows after the retired host purge.
    useAppStore.setState({ projectGroups })
  })
  await waitFor(() => expect(replies).toHaveLength(2))
  await act(async () => replies[0](createCompatibleRuntimeStatusResponse('retired-pairing')))
  expect(view.result.current).toHaveLength(1)
  expect(view.result.current.every((group) => group.executionHostId === 'runtime:quiet')).toBe(true)
  const replacement = createCompatibleRuntimeStatusResponse('replacement-pairing')
  replacement.result.capabilities = replacement.result.capabilities?.filter(
    (capability) => capability !== PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
  )
  await act(async () => replies[1](replacement))
  await waitFor(() => expect(view.result.current).toHaveLength(2))
  expect(view.result.current.map((group) => group.supportsArchiveHooks)).toEqual([false, true])
  view.unmount()
  await act(async () => useAppStore.getState().setRuntimeEnvironments([]))
})
