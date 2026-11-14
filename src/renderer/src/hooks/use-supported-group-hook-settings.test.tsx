// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../components/settings/__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store'
import { createProjectGroup } from '../../../shared/project-groups'
import { PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY } from '../../../shared/worktree-runtime-capabilities'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { useSupportedGroupHookSettings } from './use-supported-group-hook-settings'
import { ProjectGroupHooksSection } from '@/components/settings/repository/hooks/ProjectGroupHooksSection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { buildRemoteSettingsSections } from './settings-navigation-remote-sections'
import { matchesSettingsSearch } from '@/components/settings/search/settings-search'
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

it('keeps Archive unavailable on Setup-only hosts and shares capability inspection across their groups', async () => {
  // Two hosts need two status replies, regardless of how many groups they own.
  for (const count of [10, 100]) {
    clearRuntimeCompatibilityCache()
    act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() }))
    const call = vi.fn(async ({ selector }: { selector: string }) => {
      const response = createCompatibleRuntimeStatusResponse(selector)
      if (selector === 'setup-only') {
        response.result.capabilities = response.result.capabilities?.filter(
          (capability) => capability !== PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
        )
      }
      return response
    })
    Object.defineProperty(window.api, 'runtimeEnvironments', {
      configurable: true,
      value: { call }
    })
    const projectGroups = Array.from({ length: count }, (_, i) => ({
      ...createProjectGroup({
        name: `Group ${i}`,
        parentPath: `/groups/${i}`,
        createdFrom: 'manual',
        tabOrder: i
      }),
      executionHostId: i % 2 === 0 ? 'runtime:modern' : 'runtime:setup-only'
    }))
    act(() => useAppStore.setState({ projectGroups }))
    const view = renderHook(() => useSupportedGroupHookSettings())
    await waitFor(() => expect(view.result.current).toHaveLength(count))
    expect(view.result.current.map((group) => group.supportsArchiveHooks)).toEqual(
      Array.from({ length: count / 2 }, () => [true, false]).flat()
    )
    expect(call.mock.calls.map(([request]) => request.selector).sort()).toEqual([
      'modern',
      'setup-only'
    ])
    for (const name of ['Renamed group', 'Renamed again']) {
      await act(async () =>
        useAppStore.setState((state) => ({
          projectGroups: state.projectGroups.map((group, i) =>
            i === 0
              ? {
                  ...group,
                  name,
                  hookSettings: {
                    mode: 'override' as const,
                    scripts: { setup: `echo ${name}`, archive: '' }
                  }
                }
              : group
          )
        }))
      )
      expect(view.result.current[0].name).toBe(name)
      expect(call).toHaveBeenCalledTimes(2)
    }
    act(() => useAppStore.setState({ settingsSearchQuery: 'Archive' }))
    expect(call).toHaveBeenCalledTimes(2)
    act(() =>
      useAppStore.setState((state) => ({
        projectGroups: [
          ...state.projectGroups,
          { ...projectGroups[0], id: 'new-host-group', executionHostId: 'runtime:new-host' }
        ]
      }))
    )
    await waitFor(() => expect(view.result.current).toHaveLength(count + 1))
    expect(view.result.current.at(-1)?.supportsArchiveHooks).toBe(true)
    expect(call.mock.calls.filter(([request]) => request.selector === 'new-host')).toHaveLength(1)
    const beforeContact = call.mock.calls.length
    await act(async () => {
      publishContact(
        'setup-only',
        createCompatibleRuntimeStatusResponse('setup-only-restarted').result,
        1
      )
      publishContact('modern', createCompatibleRuntimeStatusResponse('modern-restarted').result, 1)
    })
    await waitFor(() =>
      expect(
        view.result.current.find((group) => group.executionHostId === 'runtime:setup-only')
          ?.hookSupport?.pending
      ).toBe(false)
    )
    expect(
      call.mock.calls
        .slice(beforeContact)
        .map(([request]) => request.selector)
        .sort()
    ).toEqual(['modern', 'setup-only'])
    await act(async () => {
      publishContact(
        'setup-only',
        createCompatibleRuntimeStatusResponse('setup-only-restarted').result,
        2
      )
    })
    expect(call.mock.calls).toHaveLength(beforeContact + 2)
    view.unmount()
  }
})

function RecoveringGroupSettings() {
  const groups = useSupportedGroupHookSettings()
  const sections = buildRemoteSettingsSections(
    {
      isMac: true,
      isWindows: false,
      isLocalWindowsHost: false,
      isWindowsTerminalHost: false,
      isWebClient: false,
      hostQueuesMessages: false,
      managedBrowserCreationEnabled: false,
      mobileEmulatorCreationEnabled: false,
      isDev: false,
      isLinearConnected: false,
      repos: [],
      projectGroups: groups
    },
    { title: 'Hosts' },
    new Map()
  )
  return (
    <TooltipProvider>
      {sections
        .filter((section) => section.id.startsWith('group-'))
        .filter((section) => matchesSettingsSearch('archive', section.searchEntries))
        .map((section) => (
          <a key={section.id} href={`#${section.id}`}>
            Open Archive
          </a>
        ))}
      {groups.map((group) => (
        <ProjectGroupHooksSection key={group.id} group={group} />
      ))}
    </TooltipProvider>
  )
}

it('recovers mounted navigation and the real editor after contact returns without losing its draft', async () => {
  clearRuntimeCompatibilityCache()
  const group = {
    ...createProjectGroup({
      name: 'Services',
      parentPath: '/services',
      createdFrom: 'manual',
      tabOrder: 0
    }),
    id: 'services',
    executionHostId: 'runtime:recovering' as const
  }
  let phase: 'offline' | 'setup-only' | 'modern' = 'offline'
  const saved = {
    mode: 'override' as const,
    commandSourcePolicy: 'local-only' as const,
    setupRunPolicy: 'ask' as const,
    setupAgentStartupPolicy: 'start-immediately' as const,
    scripts: { setup: 'echo saved', archive: 'echo archive' }
  }
  const call = vi.fn(async ({ method }: { selector: string; method: string }) => {
    if (phase === 'offline') {
      throw new Error('offline')
    }
    if (method === 'projectGroup.checkHooks') {
      return {
        id: 'inspect',
        ok: true,
        result: {
          status: 'ok',
          hasHooks: false,
          hooks: null,
          hookSettings: saved,
          mayNeedUpdate: false,
          setupRunPolicy: 'ask',
          setupConfig: null
        }
      }
    }
    const response = createCompatibleRuntimeStatusResponse(
      phase === 'modern' ? 'recovering-new' : 'recovering'
    )
    if (phase === 'setup-only') {
      response.result.capabilities = response.result.capabilities?.filter(
        (capability) => capability !== PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
      )
    }
    return response
  })
  Object.defineProperty(window.api, 'runtimeEnvironments', { configurable: true, value: { call } })
  const updateProjectGroup = vi.fn(async () => true)
  act(() =>
    useAppStore.setState({
      projectGroups: [group],
      repos: [],
      settingsSearchQuery: '',
      updateProjectGroup
    })
  )
  render(<RecoveringGroupSettings />)
  await waitFor(() => expect(call).toHaveBeenCalled())
  expect(screen.queryByRole('textbox')).toBeNull()
  phase = 'setup-only'
  await act(async () => {
    const status = createCompatibleRuntimeStatusResponse('recovering').result
    status.capabilities = status.capabilities?.filter(
      (capability) => capability !== PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
    )
    publishContact('recovering', status, 1)
    useAppStore.setState({ projectGroups: [{ ...group, name: 'Renamed services' }] })
  })
  const setup = await screen.findByDisplayValue('echo saved')
  expect(screen.queryByRole('link', { name: 'Open Archive' })).toBeNull()
  expect(screen.queryByDisplayValue('echo archive')).toBeNull()
  fireEvent.change(setup, { target: { value: 'echo kept draft' } })
  phase = 'modern'
  await act(async () => {
    publishContact('recovering', null, 2)
    publishContact('recovering', createCompatibleRuntimeStatusResponse('recovering-new').result, 3)
  })
  await screen.findByRole('link', { name: 'Open Archive' })
  await screen.findByDisplayValue('echo archive')
  expect(screen.getByDisplayValue('echo kept draft')).toBe(setup)
  fireEvent.blur(setup)
  await waitFor(() =>
    expect(updateProjectGroup).toHaveBeenCalledWith(
      'services',
      {
        hookSettings: { ...saved, scripts: { setup: 'echo kept draft', archive: 'echo archive' } }
      },
      { hostId: 'runtime:recovering' }
    )
  )
})

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
  expect(call).toHaveBeenCalledTimes(2)
  await act(async () => {
    publishContact('replacement', createCompatibleRuntimeStatusResponse('replacement').result, 1)
  })
  await waitFor(() => expect(view.result.current[0]?.supportsArchiveHooks).toBe(true))
  view.unmount()
  replaceRuntimeEnvironmentRevisions([])
})

it('ignores the old pairing reply while only the replaced host is probed again', async () => {
  for (const count of [10, 100]) {
    clearRuntimeCompatibilityCache()
    const changing = publicRuntimeEnvironment({ id: 'changing', pairingRevision: 1 })
    const quiet = publicRuntimeEnvironment({ id: 'quiet', pairingRevision: 1 })
    const replies: ((
      response: ReturnType<typeof createCompatibleRuntimeStatusResponse>
    ) => void)[] = []
    const call = vi.fn(({ selector }: { selector: string }) =>
      selector === 'quiet'
        ? Promise.resolve(createCompatibleRuntimeStatusResponse('quiet'))
        : new Promise<ReturnType<typeof createCompatibleRuntimeStatusResponse>>((resolve) => {
            replies.push(resolve)
          })
    )
    const projectGroups = Array.from({ length: count }, (_, i) => ({
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
    await waitFor(() => expect(view.result.current).toHaveLength(count / 2))
    expect(call.mock.calls.map(([request]) => request.selector).sort()).toEqual([
      'changing',
      'quiet'
    ])
    await act(async () => {
      useAppStore.getState().setRuntimeEnvironments([{ ...changing, pairingRevision: 2 }, quiet])
      // The replacement catalog can republish the same group rows after the retired host purge.
      useAppStore.setState({ projectGroups })
    })
    await waitFor(() => expect(replies).toHaveLength(2))
    await act(async () => replies[0](createCompatibleRuntimeStatusResponse('retired-pairing')))
    expect(view.result.current).toHaveLength(count / 2)
    expect(view.result.current.every((group) => group.executionHostId === 'runtime:quiet')).toBe(
      true
    )
    const replacement = createCompatibleRuntimeStatusResponse('replacement-pairing')
    replacement.result.capabilities = replacement.result.capabilities?.filter(
      (capability) => capability !== PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
    )
    await act(async () => replies[1](replacement))
    await waitFor(() => expect(view.result.current).toHaveLength(count))
    expect(view.result.current.map((group) => group.supportsArchiveHooks)).toEqual(
      Array.from({ length: count / 2 }, () => [false, true]).flat()
    )
    expect(call.mock.calls.map(([request]) => request.selector).sort()).toEqual([
      'changing',
      'changing',
      'quiet'
    ])
    view.unmount()
    await act(async () => useAppStore.getState().setRuntimeEnvironments([]))
    expect(call).toHaveBeenCalledTimes(3)
  }
})
