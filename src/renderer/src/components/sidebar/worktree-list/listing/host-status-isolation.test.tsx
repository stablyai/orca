// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  environment,
  status,
  publish,
  ssh,
  repo,
  worktree,
  visibilityArgs,
  sectionArgs,
  sidebarCorpus,
  countArrayEntries,
  countMapEntries
} from './host-status-test-fixtures'
import { useProjectHeaderHostContexts } from '../viewport/use-project-header-host-contexts'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'
import { useSidebarSectionRows } from './use-section-rows'
import { useFolderWorkspacePathStatusRows } from './use-folder-path-statuses'
import { createProjectGroup } from '../../../../../../shared/project-groups'
import type * as FolderStatus from '@/store/folder-workspaces/folder-path-status'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { useSidebarHostVisibleScope } from './use-host-visible-scope'
import { makeFolderWorkspace } from '../../../worktree-jump-palette-test-fixtures'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type * as SshGate from '@/lib/repo-ssh-connection'
import type * as DeviceVisibility from '../../../../../../shared/workspace-creator-visibility'
import type * as Registry from '../../../../../../shared/execution-host-registry'
import type * as RowPlan from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import type * as Visibility from '../../visible-worktrees'
import type * as HeaderContext from '../rows/project-header-host-context'
import { collapsedSameNameProjectHeaders } from '../../worktree-list-groups-test-fixtures'

const runtimeRpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClient>()),
  callRuntimeRpc: runtimeRpc.callRuntimeRpc
}))
const counts = vi.hoisted(() => ({
  devices: 0,
  deviceEntries: 0,
  registry: 0,
  registryEntries: 0,
  plan: 0,
  visibility: 0,
  gates: 0,
  contexts: 0,
  dependencies: 0,
  dependencyEntries: 0,
  snapshots: 0,
  statusReads: 0,
  contextEntries: 0
}))
vi.mock('@/store/folder-workspaces/folder-path-status', async (original) => {
  const actual = await original<typeof FolderStatus>()
  return {
    ...actual,
    getFolderWorkspaceStatusRequestDependencies: (
      ...args: Parameters<typeof actual.getFolderWorkspaceStatusRequestDependencies>
    ) => {
      counts.dependencies++
      return actual.getFolderWorkspaceStatusRequestDependencies(
        {
          ...args[0],
          repos: countArrayEntries(args[0].repos, () => counts.dependencyEntries++),
          projectGroups: countArrayEntries(args[0].projectGroups, () => counts.dependencyEntries++),
          folderWorkspaces: countArrayEntries(
            args[0].folderWorkspaces,
            () => counts.dependencyEntries++
          )
        },
        args[1],
        args[2]
      )
    },
    getFolderWorkspaceStatusRequestSnapshot: (
      ...args: Parameters<typeof actual.getFolderWorkspaceStatusRequestSnapshot>
    ) => {
      counts.snapshots++
      return actual.getFolderWorkspaceStatusRequestSnapshot(...args)
    }
  }
})
vi.mock('@/lib/repo-ssh-connection', async (original) => {
  const actual = await original<typeof SshGate>()
  return {
    ...actual,
    selectRepoSshGateInput: (...args: Parameters<typeof actual.selectRepoSshGateInput>) => {
      counts.gates++
      return actual.selectRepoSshGateInput(...args)
    }
  }
})
vi.mock('../../../../../../shared/workspace-creator-visibility', async (original) => {
  const actual = await original<typeof DeviceVisibility>()
  return {
    ...actual,
    getPairedDeviceIdsByEnvironment: (
      ...args: Parameters<typeof actual.getPairedDeviceIdsByEnvironment>
    ) => {
      counts.devices++
      return actual.getPairedDeviceIdsByEnvironment(
        countArrayEntries(args[0], () => counts.deviceEntries++),
        args[1]
      )
    }
  }
})
vi.mock('../../../../../../shared/execution-host-registry', async (original) => {
  const actual = await original<typeof Registry>()
  return {
    ...actual,
    buildExecutionHostRegistry: (...args: Parameters<typeof actual.buildExecutionHostRegistry>) => {
      counts.registry++
      const input = args[0]
      return actual.buildExecutionHostRegistry({
        ...input,
        repos: countArrayEntries(input.repos, () => counts.registryEntries++),
        runtimeEnvironments:
          input.runtimeEnvironments &&
          countArrayEntries(input.runtimeEnvironments, () => counts.registryEntries++),
        runtimeStatusByEnvironmentId:
          input.runtimeStatusByEnvironmentId &&
          countMapEntries(input.runtimeStatusByEnvironmentId, () => counts.registryEntries++)
      })
    }
  }
})
vi.mock('../../../../../../shared/sidebar-list/sidebar-row-plan', async (original) => {
  const actual = await original<typeof RowPlan>()
  return {
    ...actual,
    planSidebarRows: (...args: Parameters<typeof actual.planSidebarRows>) => {
      counts.plan++
      return actual.planSidebarRows(...args)
    }
  }
})
vi.mock('../../visible-worktrees', async (original) => {
  const actual = await original<typeof Visibility>()
  return {
    ...actual,
    computeVisibleWorktrees: (...args: Parameters<typeof actual.computeVisibleWorktrees>) => {
      counts.visibility++
      return actual.computeVisibleWorktrees(...args)
    }
  }
})

vi.mock('../rows/project-header-host-context', async (original) => {
  const actual = await original<typeof HeaderContext>()
  return {
    ...actual,
    getProjectHeaderHostContexts: (
      args: Parameters<typeof actual.getProjectHeaderHostContexts>[0]
    ) => {
      counts.contexts++
      return actual.getProjectHeaderHostContexts({
        ...args,
        rows: countArrayEntries(args.rows, () => counts.contextEntries++),
        hosts: countArrayEntries(args.hosts, () => counts.contextEntries++),
        repoMap: countMapEntries(args.repoMap, () => counts.contextEntries++),
        runtimeEnvironments:
          args.runtimeEnvironments &&
          countArrayEntries(args.runtimeEnvironments, () => counts.contextEntries++)
      })
    }
  }
})

const initial = useAppStore.getInitialState()
beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.setState({
    runtimeEnvironments: [environment('A', 'mine'), environment('B')],
    worktreesByRepo: { [repo.id]: [worktree] }
  })
  publish('A', 1, { status: { ...status('A'), pairedDeviceId: 'mine' } })
  publish('B', 1)
  useAppStore.getState().setEnvironmentSshTargetsMetadata('A', [])
  useAppStore.getState().setEnvironmentSshConnectionState('A', 'target', ssh('connected'))
  Object.assign(counts, {
    devices: 0,
    deviceEntries: 0,
    registry: 0,
    registryEntries: 0,
    plan: 0,
    visibility: 0,
    gates: 0,
    contexts: 0,
    dependencies: 0,
    dependencyEntries: 0,
    snapshots: 0,
    statusReads: 0,
    contextEntries: 0
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('does zero device scans while off and preserves equal identities while on, including catalog fallback', () => {
  let renders = 0
  const folders = [
    makeFolderWorkspace({
      executionHostId: 'runtime:A',
      creatorProvenance: { kind: 'paired-device', deviceId: 'mine' }
    })
  ]
  const scope = {
    defaultHostId: 'local' as const,
    repos: [repo],
    projectGroups: [],
    folderWorkspaces: folders
  }
  const { result, rerender } = renderHook(
    (args) => {
      renders++
      const visible = useVisibleSidebarWorktrees(args)
      const hostScope = useSidebarHostVisibleScope({
        ...scope,
        filterState: args.filterState,
        pairedDeviceIdsByEnvironment: visible.pairedDeviceIdsByEnvironment
      })
      return { ...visible, folders: hostScope.visibleFolderWorkspacesForRows }
    },
    { initialProps: visibilityArgs }
  )
  const first = result.current
  const before = renders
  for (let flip = 0; flip < 10; flip++) {
    act(() => publish('B', flip + 2, { status: flip % 2 ? null : status('B') }))
  }
  expect(renders).toBe(before)
  expect(result.current).toBe(first)
  expect(counts.devices).toBe(0)
  expect(counts.deviceEntries).toBe(0)
  rerender({
    ...visibilityArgs,
    filterState: { ...visibilityArgs.filterState, hideWorkspacesFromOtherDevices: true }
  })
  const on = result.current
  const onRenders = renders
  const scans = counts.visibility
  for (let flip = 0; flip < 10; flip++) {
    act(() => publish('B', flip + 12, { verification: flip % 2 ? 'unavailable' : 'verified' }))
  }
  act(() => publish('A', 2, { status: { ...status('A'), pairedDeviceId: 'mine' } }))
  expect(renders).toBe(onRenders)
  expect(result.current).toBe(on)
  expect(counts.visibility).toBe(scans)
  const deviceScans = counts.devices
  act(() => useAppStore.setState({ sshTargetLabels: new Map([['other', 'Other']]) }))
  expect(counts.devices).toBe(deviceScans)
  act(() => publish('A', 3, { status: { ...status('A'), pairedDeviceId: 'someone-else' } }))
  expect(result.current.visibleWorktrees).toEqual([])
  expect(result.current.folders).toEqual([])
  rerender(visibilityArgs)
  expect(result.current.folders).toEqual(folders)
  rerender({
    ...visibilityArgs,
    filterState: { ...visibilityArgs.filterState, hideWorkspacesFromOtherDevices: true }
  })
  expect(result.current.folders).toEqual([])
  act(() =>
    useAppStore.setState({
      runtimeEnvironments: [environment('A', 'mine'), environment('B')],
      runtimeStatusByEnvironmentId: new Map()
    })
  )
  expect(result.current.pairedDeviceIdsByEnvironment.get('A')).toBe('mine')
  expect(result.current.visibleWorktrees).toEqual([worktree])
  expect(result.current.folders).toEqual(folders)
  act(() => useAppStore.setState({ runtimeEnvironments: [] }))
  expect(result.current.pairedDeviceIdsByEnvironment.size).toBe(0)
  rerender(visibilityArgs)
  expect(result.current.folders).toEqual(folders)
  const off = counts.devices
  act(() => useAppStore.setState({ runtimeEnvironments: [environment('A', 'new')] }))
  expect(counts.devices).toBe(off)
})

it('keeps equal host options and health-only changes out of the workspace row plan', () => {
  const args = sectionArgs()
  let renders = 0
  const { result } = renderHook(() => {
    renders++
    return useSidebarSectionRows(args)
  })
  const first = result.current
  const before = renders
  const plans = counts.plan
  for (let flip = 0; flip < 10; flip++) {
    act(() => publish('B', flip + 2, { status: { ...status('B'), liveTabCount: flip } }))
  }
  act(() => publish('A', 2, { status: { ...status('A'), liveTabCount: 99 } }))
  expect(renders).toBe(before)
  expect(result.current).toBe(first)
  expect(counts.plan).toBe(plans)
  const builds = counts.registry
  act(() => useAppStore.setState({ sshStateByEnvironment: new Map() }))
  expect(counts.registry).toBe(builds)
  act(() => publish('A', 3, { verification: 'checking', transport: 'connecting' }))
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')?.health).toBe(
    'connecting'
  )
  expect(counts.plan).toBe(plans)
  expect(result.current.occurrencePlan).toBe(first.occurrencePlan)
  act(() =>
    useAppStore.setState({
      runtimeEnvironments: [environment('A'), { ...environment('B'), name: 'Renamed' }]
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:B')?.label).toBe('Renamed')
  expect(counts.plan).toBe(plans + 1)
  act(() =>
    publish('A', 4, {
      status: { ...status('A'), capabilities: ['new-capability'], hostPlatform: 'linux' }
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')).toMatchObject({
    capabilities: ['new-capability'],
    platform: 'linux'
  })
  act(() =>
    useAppStore.setState({
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map([
        ['status-only', { status: status('status-only'), checkedAt: 1 }]
      ])
    })
  )
  expect(result.current.hostOptions.map((host) => host.id)).toContain('runtime:status-only')
  expect(result.current.hostOptions.map((host) => host.id)).not.toContain('runtime:B')
})

it('keeps compatibility, blocked guidance, aliases and diagnostic equality live in the host projection', () => {
  const control = {
    state: 'ready' as const,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 0,
    lastConnectedAt: 1,
    lastClose: null,
    lastError: null,
    lastRttMs: 1
  }
  publish('A', 2, { remoteControl: control })
  const args = sectionArgs()
  let renders = 0
  const { result } = renderHook(() => {
    renders++
    return useSidebarSectionRows(args)
  })
  const before = renders
  const options = result.current.hostOptions
  act(() =>
    publish('A', 3, {
      remoteControl: { ...control, lastRttMs: 99, pendingRequestCount: 10, subscriptionCount: 5 }
    })
  )
  expect(renders).toBe(before)
  expect(result.current.hostOptions).toBe(options)
  act(() => publish('A', 4, { verification: 'blocked', blockedReason: 'access-revoked' }))
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')).toMatchObject({
    health: 'blocked',
    blockedReason: 'access-revoked'
  })
  act(() => publish('A', 5, { status: { ...status('A'), runtimeProtocolVersion: 0 } }))
  expect(
    result.current.hostOptions.find((host) => host.id === 'runtime:A')?.compatibility
  ).toMatchObject({ kind: 'blocked', reason: 'server-too-old' })
  act(() =>
    useAppStore.setState({
      sshTargetLabels: new Map([['managed', 'My machine']]),
      runtimeEnvironments: [
        {
          ...environment('A'),
          orcadDeployment: {
            sshTargetId: 'managed',
            sshTargetGeneration: 1,
            localPort: 7001,
            remotePort: 7002
          }
        }
      ]
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'runtime:A')).toMatchObject({
    label: 'My machine',
    aliasHostIds: ['ssh:managed']
  })
  act(() =>
    useAppStore.setState({
      sshConnectionStates: new Map([
        [
          'managed',
          {
            ...ssh('connected', 'managed'),
            managedServer: { kind: 'relay', reason: 'orcad_unavailable' }
          }
        ]
      ])
    })
  )
  expect(result.current.hostOptions.find((host) => host.id === 'ssh:managed')).toMatchObject({
    aliasHostIds: ['runtime:A']
  })
})

it.each([
  { repos: 10, hosts: 10 },
  { repos: 100, hosts: 10 },
  { repos: 10, hosts: 100 },
  { repos: 100, hosts: 100 }
])(
  'bounds one sidebar publication workload with $repos repos, $hosts hosts and three workspaces per repo',
  ({ repos: repoCount, hosts: hostCount }) => {
    const args = sidebarCorpus(repoCount, hostCount)
    const dependencyCount = hostCount === 100 ? repoCount : 1
    const projectGroups: ProjectGroup[] = Array.from({ length: repoCount }, (_, index) => ({
      ...createProjectGroup({
        name: `Group ${index}`,
        parentPath: `/folders/${index}`,
        createdFrom: 'folder-scan',
        tabOrder: index,
        now: 1
      }),
      id: `group-${index}`,
      executionHostId: 'runtime:host-0',
      connectionId: `target-${index % dependencyCount}`
    }))
    projectGroups.push({
      ...projectGroups[0]!,
      id: 'nested',
      parentPath: null,
      parentGroupId: 'group-0'
    })
    const folderWorkspaces = Array.from({ length: repoCount }, (_, index) =>
      makeFolderWorkspace({
        id: `folder-${index}`,
        projectGroupId: 'group-0',
        executionHostId: 'runtime:host-0',
        folderPath: `/folders/0/${index}`
      })
    )
    args.repos[0] = { ...args.repos[0]!, projectGroupId: 'nested' }
    args.repoMap.set(args.repos[0]!.id, args.repos[0]!)
    useAppStore.setState({ repos: args.repos, projectGroups, folderWorkspaces })
    // Keep requests pending: count production discovery/action snapshots without settlement writes.
    const callRuntimeRpc = vi.fn(() => new Promise<never>(() => {}))
    runtimeRpc.callRuntimeRpc.mockImplementation(callRuntimeRpc)
    const fetch = vi.fn(useAppStore.getState().fetchFolderWorkspacePathStatus)
    useAppStore.setState({ fetchFolderWorkspacePathStatus: fetch })
    const folderArgs = {
      allRepoIds: args.repos.map((repo) => repo.id),
      repoMap: args.repoMap,
      projectGroups,
      folderWorkspaces
    }
    const visibleArgs = {
      ...visibilityArgs,
      repoMap: args.repoMap,
      sortedIds: args.worktrees.map((item) => item.id),
      filterState: { ...visibilityArgs.filterState, hideWorkspacesFromOtherDevices: true }
    }
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      const visible = useVisibleSidebarWorktrees(visibleArgs)
      const section = useSidebarSectionRows({ ...args, worktrees: visible.visibleWorktrees })
      return {
        visible,
        section,
        folder: useFolderWorkspacePathStatusRows(folderArgs),
        contexts: useProjectHeaderHostContexts({
          rows: section.sectionRows,
          hosts: section.hostOptions,
          repoMap: args.repoMap
        })
      }
    })
    const before = { ...counts }
    expect(counts.dependencies).toBe(2 * repoCount)
    expect(counts.dependencyEntries).toBeGreaterThan(2 * repoCount * repoCount)
    expect(counts.dependencyEntries).toBeLessThanOrEqual(
      2 * repoCount * (5 * projectGroups.length + 2 * repoCount)
    )
    expect(fetch).toHaveBeenCalledTimes(2 * repoCount)
    expect(
      fetch.mock.calls.every(
        ([, options]) => options.force && options.runtimeEnvironmentId === 'host-0'
      )
    ).toBe(true)
    const first = result.current
    const settledRenders = renders
    const fleet = hostCount + 1
    expect(first.visible.visibleWorktrees).toHaveLength(3 * repoCount)
    expect(first.section.sectionRows).toHaveLength(repoCount)
    expect(first.contexts.size).toBe(repoCount)
    for (let sequence = 2; sequence < 12; sequence++) {
      act(() => publish('B', sequence, { status: { ...status('B'), liveTabCount: sequence } }))
    }
    expect(renders).toBe(settledRenders)
    expect(result.current).toBe(first)
    // Expensive verdicts must not grow with targets owned by unchanged hosts.
    expect(counts.gates - before.gates).toBe(0)
    expect(counts.devices - before.devices).toBe(10)
    expect(counts.deviceEntries - before.deviceEntries).toBe(10 * fleet)
    expect(counts.registry - before.registry).toBe(10)
    expect(counts.registryEntries - before.registryEntries).toBe(10 * (3 * fleet + 2 * repoCount))
    expect(counts.contexts).toBe(before.contexts)
    expect(counts.contextEntries).toBe(before.contextEntries)
    expect(counts.plan).toBe(before.plan)
    expect(counts.visibility).toBe(before.visibility)
    const snapshots = { ...counts }
    function statusMap(value: 'connected' | 'disconnected') {
      const map = new Map([['outside', ssh(value, 'outside')]])
      const get = map.get.bind(map)
      map.get = (key) => {
        if (key.startsWith('target-')) {
          counts.statusReads++
        }
        return get(key)
      }
      return map
    }
    for (let sequence = 0; sequence < 10; sequence++) {
      act(() =>
        useAppStore.setState({
          sshConnectionStates: statusMap(sequence % 2 ? 'connected' : 'disconnected')
        })
      )
    }
    expect(renders).toBe(settledRenders)
    expect(result.current).toBe(first)
    expect(counts.gates - snapshots.gates).toBe(0)
    expect(counts.contexts - snapshots.contexts).toBe(10)
    expect(counts.contextEntries - snapshots.contextEntries).toBe(
      10 * (2 * fleet + 1 + 2 * repoCount)
    )
    expect(counts.registry - snapshots.registry).toBe(10)
    expect(counts.registryEntries - snapshots.registryEntries).toBe(
      10 * (3 * fleet + 2 * repoCount)
    )
    expect(counts.devices).toBe(snapshots.devices)
    expect(counts.plan).toBe(before.plan)
    expect(counts.dependencies).toBe(before.dependencies)
    expect(counts.dependencyEntries).toBe(before.dependencyEntries)
    expect(counts.snapshots).toBe(before.snapshots)
    expect(fetch).toHaveBeenCalledTimes(2 * repoCount)
    expect(counts.statusReads - snapshots.statusReads).toBe(10 * dependencyCount)
    const localSsh = { ...counts }
    for (let sequence = 0; sequence < 10; sequence++) {
      act(() =>
        useAppStore
          .getState()
          .setEnvironmentSshConnectionState(
            'B',
            'outside',
            ssh(sequence % 2 ? 'connected' : 'disconnected', 'outside')
          )
      )
    }
    expect(renders).toBe(settledRenders)
    expect(result.current).toBe(first)
    expect(counts.gates - localSsh.gates).toBe(0)
    expect(counts.registry).toBe(localSsh.registry)
    expect(counts.devices).toBe(localSsh.devices)
    expect(counts.contexts).toBe(localSsh.contexts)
    expect(counts.dependencies).toBe(before.dependencies)
    expect(counts.snapshots).toBe(before.snapshots)
    const equal = { ...counts }
    act(() => publish('host-0', 2, { status: { ...status('host-0'), liveTabCount: 99 } }))
    expect(renders).toBe(settledRenders)
    expect(result.current).toBe(first)
    expect(counts.gates - equal.gates).toBe(0)
    expect(counts.deviceEntries - equal.deviceEntries).toBe(fleet)
    act(() =>
      useAppStore
        .getState()
        .setEnvironmentSshConnectionState('host-0', 'target-0', ssh('disconnected', 'target-0'))
    )
    expect(renders).toBe(settledRenders)
    expect(result.current).toBe(first)
    act(() =>
      useAppStore.setState({
        sshConnectionStates: new Map([['target-0', ssh('connected', 'target-0')]])
      })
    )
    expect(fetch).toHaveBeenCalledTimes(4 * repoCount)
    expect(counts.dependencies).toBe(before.dependencies)
    expect(counts.snapshots - before.snapshots).toBe(2 * repoCount)
    expect(renders).toBeGreaterThan(settledRenders)
    const catalogBuilds = counts.dependencies
    act(() =>
      useAppStore.setState((state) => ({
        repos: state.repos.map((repo, index) =>
          index === 0 ? { ...repo, path: '/moved/repo' } : repo
        )
      }))
    )
    expect(counts.dependencies - catalogBuilds).toBe(2 * repoCount)
    expect(fetch).toHaveBeenCalledTimes(6 * repoCount)
    // Requests remain accepted when their snapshot becomes null; route/force policy is unchanged.
    act(() => useAppStore.setState({ projectGroups: [], folderWorkspaces: [] }))
    expect(fetch).toHaveBeenCalledTimes(8 * repoCount)
    expect(
      fetch.mock.calls.every(
        ([, options]) => options.force && options.runtimeEnvironmentId === 'host-0'
      )
    ).toBe(true)
    const healthPlans = counts.plan
    const occurrencePlan = result.current.section.occurrencePlan
    act(() => publish('host-0', 3, { verification: 'checking', transport: 'connecting' }))
    expect(
      result.current.section.hostOptions.find((host) => host.id === 'runtime:host-0')?.health
    ).toBe('connecting')
    expect(counts.plan).toBe(healthPlans)
    expect(result.current.section.occurrencePlan).toBe(occurrencePlan)
    act(() => publish('host-0', 4, { status: { ...status('host-0'), pairedDeviceId: 'other' } }))
    expect(result.current.visible.visibleWorktrees).toHaveLength(
      3 * (repoCount - Math.ceil(repoCount / hostCount))
    )
  }
)

it('keeps real collapsed same-name header contexts reactive through parent host options and row scope', () => {
  const fixture = collapsedSameNameProjectHeaders()
  useAppStore.setState({
    runtimeEnvironments: [{ ...environment('home'), name: 'Home' }, environment('B')],
    runtimeStatusByEnvironmentId: new Map(),
    worktreesByRepo: {}
  })
  publish('home', 1)
  const args = {
    ...sectionArgs(),
    repos: [fixture.local, fixture.paired],
    visibleReposForRows: [fixture.local, fixture.paired],
    worktrees: [],
    worktreeMap: new Map(),
    repoMap: fixture.repoMap
  }
  let renders = 0
  const { result, rerender } = renderHook(
    (rows) => {
      renders++
      const section = useSidebarSectionRows(args)
      return useProjectHeaderHostContexts({
        rows,
        repoMap: fixture.repoMap,
        hosts: section.hostOptions
      })
    },
    { initialProps: fixture.rows }
  )
  const first = result.current
  const before = renders
  expect(first.size).toBe(2)
  expect(first.get(fixture.rows[1]!.key)).toMatchObject({ hostId: 'runtime:home', label: 'Home' })
  for (let sequence = 0; sequence < 10; sequence++) {
    act(() =>
      useAppStore.setState({
        sshConnectionStates: new Map([
          ['outside', ssh(sequence % 2 ? 'connected' : 'disconnected')]
        ])
      })
    )
  }
  act(() =>
    useAppStore.setState({ runtimeEnvironments: [...useAppStore.getState().runtimeEnvironments] })
  )
  expect(renders).toBe(before)
  expect(result.current).toBe(first)
  act(() =>
    useAppStore.setState({
      runtimeEnvironments: [{ ...environment('home'), name: 'Renamed home' }, environment('B')]
    })
  )
  expect(renders).toBeGreaterThan(before)
  expect(result.current).not.toBe(first)
  expect(result.current.get(fixture.rows[1]!.key)?.label).toBe('Renamed home')
  const renamedRenders = renders
  rerender([fixture.rows[0]!])
  expect(renders).toBeGreaterThan(renamedRenders)
  expect(result.current.size).toBe(0)
})
