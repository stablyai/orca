import type { Store } from '../../../../main/persistence/loading-store/store'
import { ProjectGroupMoveProjectArgs } from '../../../../main/ipc/repos/repo-ipc-arg-schemas'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type userEvent from '@testing-library/user-event'
import { act } from 'react'
import { cleanup, screen, waitFor, fireEvent } from '@testing-library/react'

import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { expect, vi } from 'vitest'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import {
  ProjectGroupCreate,
  ProjectGroupMoveProject
} from '../../../../shared/rpc-contract/repo-params'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

import { getRepoRowIdentity } from '@/store/repos/repo-host-identity'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { type ExecutionHostId, getRepoExecutionHostId } from '../../../../shared/execution-host'
import { worktree } from './worktree-list/grouping/worktree-list-groups-test-fixtures'
import { local } from './qualified-notice-actions-test-fixtures'
export async function groupActionFixture(input: {
  localRepos: Repo[]
  remoteRepos?: Repo[]
  mode?: 'repository' | 'host' | 'folder'
  equalIdDestination?: boolean
}) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const harness = await import('../../../../main/persistence/persistence-test-harness')
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr35595-group-actions-'))
  harness.testState.dir = join(directory, 'local')
  const localDisk = harness.createStore()
  const target = { kind: 'environment' as const, environmentId: 'server' }
  for (const entry of input.localRepos) {
    localDisk.addRepo(entry)
  }
  const localGroup = localDisk.createProjectGroup({
    name: 'Local destination',
    createdFrom: 'manual'
  })
  harness.testState.dir = join(directory, 'remote')
  if (input.equalIdDestination) {
    harness.writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [{ ...localGroup, name: 'Remote equal-ID destination' }]
    })
  }
  const remoteDisk = harness.createStore()
  for (const entry of input.remoteRepos ?? []) {
    remoteDisk.addRepo(entry)
  }
  const remoteGroup = input.equalIdDestination
    ? remoteDisk.getProjectGroups()[0]!
    : remoteDisk.createProjectGroup({ name: 'Remote destination', createdFrom: 'manual' })
  const localProjection = projectHostSetupProjectionFromRepos(input.localRepos)
  const remoteProjection = projectHostSetupProjectionFromRepos(input.remoteRepos ?? [])
  const adopted = adoptEndpointProjectCatalog(
    target,
    remoteProjection.projects,
    remoteProjection.setups
  )
  const repos = [
    ...input.localRepos.map((entry) => adoptEndpointRepo({ kind: 'local' }, entry)),
    ...(input.remoteRepos ?? []).map((entry) => adoptEndpointRepo(target, entry))
  ]
  const settings = {
    ...getDefaultSettings('/tmp'),
    projectGroupingMode: input.mode ?? 'repository'
  }
  const moves: { catalog: string; id: string; groupId: string | null }[] = []
  let beforeMove:
    | ((catalog: string, id: string, groupId: string | null) => Promise<void>)
    | undefined
  const receivingMove = async (
    catalog: string,
    disk: Store,
    args: {
      id: string
      hostId?: ExecutionHostId
      connectionId?: string | null
      groupId: string | null
      order?: number
    }
  ) => {
    moves.push({ catalog, id: args.id, groupId: args.groupId })
    await beforeMove?.(catalog, args.id, args.groupId)
    return disk.moveProjectToGroup(
      { id: args.id, executionHostId: args.hostId, connectionId: args.connectionId },
      args.groupId,
      args.order
    )
  }
  const createLocal = vi.fn<Window['api']['projectGroups']['create']>(async (args) =>
    localDisk.createProjectGroup({ ...args, createdFrom: args.createdFrom ?? 'manual' })
  )
  const createRemote = vi.fn((name: string) =>
    remoteDisk.createProjectGroup({ name, createdFrom: 'manual' })
  )
  Object.assign(window, {
    api: {
      ...window.api,
      platform: { get: () => ({ platform: 'darwin' }) },
      projectGroups: {
        ...window.api?.projectGroups,
        create: createLocal,
        moveProject: async (
          input: Parameters<Window['api']['projectGroups']['moveProject']>[0]
        ) => {
          const args = ProjectGroupMoveProjectArgs.parse(input)
          return receivingMove('local', localDisk, {
            id: args.projectId,
            hostId: args.hostId,
            groupId: args.groupId,
            order: args.order
          })
        }
      },
      runtimeEnvironments: {
        ...window.api?.runtimeEnvironments,
        call: async (request: Parameters<Window['api']['runtimeEnvironments']['call']>[0]) => {
          const compatible = createCompatibleRuntimeStatusResponseIfNeeded({
            method: request.method
          })
          if (compatible) {
            return compatible
          }
          if (request.method === 'projectGroup.moveProject') {
            const args = ProjectGroupMoveProject.parse(request.params)
            const result = await receivingMove('remote', remoteDisk, {
              id: args.repo,
              connectionId: args.connectionId,
              groupId: args.groupId ?? null,
              order: args.order
            })
            return {
              id: 'move',
              ok: true,
              result: { repo: result },
              _meta: { runtimeId: 'remote-runtime' }
            }
          }
          if (request.method === 'projectGroup.create') {
            const args = ProjectGroupCreate.parse(request.params)
            return {
              id: 'create',
              ok: true,
              result: { group: createRemote(args.name) },
              _meta: { runtimeId: 'remote-runtime' }
            }
          }
          throw new Error(`Unexpected service method ${request.method}`)
        }
      }
    }
  })
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState({
    repos,
    projects: [...localProjection.projects, ...adopted.projects],
    projectHostSetups: [...localProjection.setups, ...adopted.setups],
    projectGroups: [localGroup, { ...remoteGroup, executionHostId: 'runtime:server' }],
    settings,
    groupBy: 'repo',
    sortBy: 'manual',
    projectOrderBy: 'manual',
    workspaceHostScope: 'all',
    worktreesByRepo: Object.fromEntries(
      repos.map((entry, index) => [
        entry.id,
        [
          {
            ...worktree,
            id: `${getRepoRowIdentity(entry)}-main`,
            repoId: entry.id,
            path: entry.path,
            displayName: `${entry.id} checkout`,
            hostId: getRepoExecutionHostId(entry),
            sortOrder: index,
            isMainWorktree: true
          }
        ]
      ])
    )
  })
  return {
    localDisk,
    remoteDisk,
    localGroup,
    remoteGroup,
    repos,
    moves,
    createLocal,
    createRemote,
    intercept: (callback?: typeof beforeMove) => {
      beforeMove = callback
    },
    async saved() {
      localDisk.flush()
      remoteDisk.flush()
      return {
        local: harness.readPersistedState(join(directory, 'local', 'orca-data.json')).repos,
        remote: harness.readPersistedState(join(directory, 'remote', 'orca-data.json')).repos
      }
    },
    async dispose() {
      cleanup()
      await harness.closeTestStores()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

export function groupRepo(id: string, extra: Partial<Repo> = {}): Repo {
  return {
    ...local,
    id,
    displayName: 'Harbor',
    path: `/${id}`,
    upstream: { owner: 'org', repo: 'harbor' },
    ...extra
  }
}

// Card menus nest group actions under "Project Group"; header menus list them directly.
export async function openCardProjectGroupMenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.queryByRole('menuitem', { name: 'Project Group' })
  if (trigger) {
    await user.hover(trigger)
    await waitFor(() => screen.getByRole('menuitem', { name: 'New group from project' }))
  }
}

export async function openGroupDestinations(user: ReturnType<typeof userEvent.setup>) {
  const moveTrigger = screen.queryByRole('menuitem', { name: 'Move to group' })
  await (moveTrigger ? user.hover(moveTrigger) : openCardProjectGroupMenu(user))
}

// Fire the item in place: a pointer move off the submenu trigger can close it first.
async function fireMenuItem(item: HTMLElement) {
  await act(async () => {
    fireEvent.pointerDown(item, { button: 0 })
    item.click()
  })
}

export async function chooseGroupAction(user: ReturnType<typeof userEvent.setup>, name: string) {
  await openCardProjectGroupMenu(user)
  await fireMenuItem(screen.getByRole('menuitem', { name }))
}

export function queryGroupDestination(name: string): HTMLElement | null {
  return screen.queryByRole('menuitem', { name }) ?? screen.queryByRole('menuitemradio', { name })
}

export async function selectGroup(user: ReturnType<typeof userEvent.setup>, name: string) {
  await openGroupDestinations(user)
  await waitFor(() => expect(queryGroupDestination(name)).toBeTruthy())
  await fireMenuItem(queryGroupDestination(name)!)
}

export function countedProperty(
  row: Pick<Repo, 'id'> | Pick<ProjectHostSetup, 'repoId'>,
  property: 'id' | 'repoId' | 'projectGroupId' | 'projectGroupOrder' | 'executionHostId',
  read: () => void
) {
  const descriptor = Object.getOwnPropertyDescriptor(row, property)
  if (descriptor?.get) {
    return
  }
  let value: unknown = descriptor?.value
  Object.defineProperty(row, property, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      read()
      return value
    },
    set(next: unknown) {
      value = next
    }
  })
}

export function hasRepoIdentityRows(value: unknown): value is { repos: Pick<Repo, 'id'>[] } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'repos' in value &&
    Array.isArray(value.repos) &&
    value.repos.every(
      (row: unknown) => row && typeof row === 'object' && 'id' in row && typeof row.id === 'string'
    )
  )
}
