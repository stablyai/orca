import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
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
  countArrayEntries,
  countMapEntries
} from './host-status-test-fixtures'
import { useProjectHeaderHostContexts } from '../viewport/use-project-header-host-contexts'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'
import { useSidebarSectionRows } from './use-section-rows'

import type * as FolderStatus from '@/store/folder-workspaces/folder-path-status'

import { useSidebarHostVisibleScope } from './use-host-visible-scope'
import { makeFolderWorkspace } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'

import type * as SshGate from '@/lib/repo-ssh-connection'
import type * as DeviceVisibility from '../../../../../../shared/workspace-creator-visibility'
import type * as Registry from '../../../../../../shared/execution-host-registry'
import type * as RowPlan from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import type * as Visibility from './compute-visible-worktrees'
import type * as HeaderContext from '../rows/project-header-host-context'
import { collapsedSameNameProjectHeaders } from '../grouping/worktree-list-groups-test-fixtures'

const runtimeRpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original<typeof RuntimeRpcCallModule>()),
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
vi.mock('./compute-visible-worktrees', async (original) => {
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
