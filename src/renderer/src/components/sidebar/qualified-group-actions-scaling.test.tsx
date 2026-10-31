// @vitest-environment happy-dom
import type { AppState } from '@/store/types'

import {
  groupActionFixture,
  groupRepo,
  selectGroup,
  countedProperty,
  hasRepoIdentityRows
} from './project-group-actions-test-fixtures'
import { act, useLayoutEffect } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { adoptEndpointRepo } from '../../../../shared/endpoint-catalog-adoption'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'

import { getRepoRowIdentity } from '@/store/slices/repo-host-identity'
import * as groupOperations from './project-group-operation'
import WorktreeContextMenu from './WorktreeContextMenu'
import {
  type ProjectGroupOperationOwner,
  ProjectGroupOperationContext,
  useProjectGroupOperation
} from './use-project-group-operation'

import { TooltipProvider } from '../ui/tooltip'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { worktree } from './worktree-list-groups-test-fixtures'
import { useProjectGroupDialogs } from './worktree-list/rows/use-project-group-dialogs'
it('bounds real open/accept operations at N100/1000 with q2 independent growth and qN changed saved targets, charging downstream scans', async () => {
  for (const n of [100, 1000]) {
    for (const scope of ['two', 'all'] as const) {
      const q = scope === 'two' ? 2 : n
      const fixture = await groupActionFixture({
        localRepos: Array.from({ length: q }, (_, i) => groupRepo(`target-${i}`)),
        remoteRepos: Array.from({ length: n - q }, (_, i) =>
          groupRepo(`other-${i}`, { upstream: { owner: 'org', repo: `unrelated-${i}` } })
        )
      })
      const foreignGroups = Array.from({ length: n }, (_, i) => ({
        ...fixture.remoteDisk.createProjectGroup({ name: `Foreign ${i}`, createdFrom: 'manual' }),
        executionHostId: 'runtime:server' as const
      }))
      useAppStore.setState((state) => ({
        projectGroups: [...state.projectGroups, ...foreignGroups]
      }))
      const counts = {
        setupReads: 0,
        repoReads: 0,
        destinationReads: 0,
        destinationCatalogReads: 0,
        receivingRepoReads: 0,
        receivingOrderReads: 0,
        publications: 0
      }
      const instrumented = new WeakSet<Pick<Repo, 'id'> | Pick<ProjectHostSetup, 'repoId'>>()
      const instrument = (state: AppState) => {
        for (const row of state.repos) {
          if (!instrumented.has(row)) {
            instrumented.add(row)
            countedProperty(row, 'id', () => {
              counts.repoReads++
            })
          }
        }
        for (const row of state.projectHostSetups) {
          if (!instrumented.has(row)) {
            instrumented.add(row)
            countedProperty(row, 'repoId', () => {
              counts.setupReads++
            })
          }
        }
        for (const row of state.projectGroups) {
          if (!instrumented.has(row)) {
            instrumented.add(row)
            countedProperty(row, 'id', () => {
              counts.destinationReads++
            })
            countedProperty(row, 'executionHostId', () => {
              counts.destinationCatalogReads++
            })
          }
        }
      }
      const stateValue: unknown = Object.getOwnPropertyDescriptor(fixture.localDisk, 'state')?.value
      expect(hasRepoIdentityRows(stateValue)).toBe(true)
      if (!hasRepoIdentityRows(stateValue)) {
        throw new Error('Missing owned fixture persistence state')
      }
      for (const row of stateValue.repos) {
        countedProperty(row, 'id', () => {
          counts.receivingRepoReads++
        })
        countedProperty(row, 'projectGroupOrder', () => {
          counts.receivingOrderReads++
        })
      }
      instrument(useAppStore.getState())
      const stop = useAppStore.subscribe((state, previous) => {
        if (state.repos !== previous.repos) {
          counts.publications++
        }
        instrument(state)
      })
      const resolver = vi.spyOn(groupOperations, 'resolveProjectGroupOperation')
      const initial = useAppStore.getState()
      const wrappers = fixture.repos.map((entry) => (
        <WorktreeContextMenu
          key={getRepoRowIdentity(entry)}
          worktree={{
            ...worktree,
            id: `${entry.id}-card`,
            repoId: entry.id,
            hostId: getRepoExecutionHostId(entry)
          }}
        >
          <span>{entry.id} card</span>
        </WorktreeContextMenu>
      ))
      let capturedOwner: ProjectGroupOperationOwner | undefined
      function OperationSurface() {
        const dialogs = useProjectGroupDialogs({
          repos: initial.repos,
          repoMap: new Map(initial.repos.map((row) => [row.id, row])),
          projectGroups: initial.projectGroups
        })
        capturedOwner = dialogs.operationOwner
        return (
          <TooltipProvider>
            <ProjectGroupOperationContext.Provider value={dialogs.operationOwner}>
              {wrappers}
            </ProjectGroupOperationContext.Provider>
          </TooltipProvider>
        )
      }
      try {
        render(<OperationSurface />)
        expect(resolver).not.toHaveBeenCalled()
        expect(counts.setupReads).toBe(0)
        counts.repoReads = 0
        if (!capturedOwner) {
          throw new Error('Missing actual action owner')
        }
        const accepted = vi.spyOn(capturedOwner, 'move')
        const user = userEvent.setup()
        await user.pointer({ target: screen.getByText('target-0 card'), keys: '[MouseRight]' })
        await waitFor(() =>
          expect(screen.getByRole('menuitem', { name: 'Move to group' })).toBeTruthy()
        )
        const open = { ...counts, resolverCalls: resolver.mock.calls.length }
        expect(open.resolverCalls).toBe(1)
        expect(open.setupReads).toBeGreaterThanOrEqual(n)
        expect(open.setupReads).toBeLessThan(40 * n + 100)
        expect(open.destinationCatalogReads).toBeGreaterThanOrEqual(n)
        expect(open.destinationCatalogReads).toBeLessThan(20 * n + 100)
        expect(open.destinationReads).toBeGreaterThan(0)
        expect(open.destinationReads).toBeLessThan(20 * n + 100)
        await selectGroup(user, 'Local destination')
        expect(accepted).toHaveBeenCalledTimes(1)
        await act(async () => {
          expect(await accepted.mock.results[0]!.value).toBe(true)
        })
        expect(
          useAppStore.getState().repos.filter((row) => row.projectGroupId === fixture.localGroup.id)
        ).toHaveLength(q)
        expect(fixture.moves.map((move) => move.id)).toEqual(
          Array.from({ length: q }, (_, i) => `target-${i}`)
        )
        expect(resolver).toHaveBeenCalledTimes(1)
        expect(counts.publications).toBe(q)
        expect(
          (await fixture.saved()).local.filter(
            (row) => row.projectGroupId === fixture.localGroup.id
          )
        ).toHaveLength(q)
        const completed = {
          ...counts,
          resolverCalls: resolver.mock.calls.length,
          receivingCalls: fixture.moves.length
        }
        await user.pointer({ target: screen.getByText('target-0 card'), keys: '[MouseRight]' })
        screen.getByRole('menuitem', { name: 'Move to group' }).focus()
        await user.keyboard('{ArrowRight}')
        await waitFor(() =>
          expect(screen.getByRole('menuitem', { name: 'Local destination' })).toBeTruthy()
        )
        expect(
          screen.getByRole('menuitem', { name: 'Local destination' }).getAttribute('data-disabled')
        ).not.toBeNull()
        await act(async () => {
          screen.getByRole('menuitem', { name: 'Local destination' }).click()
        })
        expect(fixture.moves).toHaveLength(q)
        process.stdout.write(
          `PG G operation counts ${JSON.stringify({ n, q, scope, open, completed, noOpAdditionalWrites: fixture.moves.length - q })}\n`
        )
      } finally {
        resolver.mockRestore()
        stop()
        await fixture.dispose()
      }
    }
  }
})

it('refreshes the open selected operation and predicates together, with equal/unrelated/focus no-commit controls and own positive changes', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b')],
    remoteRepos: [groupRepo('c')]
  })
  const entrance: groupOperations.ProjectGroupEntrance = {
    kind: 'worktree',
    worktree: { ...worktree, repoId: 'a', hostId: 'local' }
  }
  let commits = 0
  let selected: ReturnType<typeof useProjectGroupOperation> = null
  const resolver = vi.spyOn(groupOperations, 'resolveProjectGroupOperation')
  function Probe() {
    selected = useProjectGroupOperation(true, entrance)
    useLayoutEffect(() => {
      commits++
    })
    return (
      <span>
        {selected?.grouped ? 'grouped' : 'ungrouped'} {selected?.destinations[0]?.name}
      </span>
    )
  }
  try {
    render(<Probe />)
    expect(commits).toBe(1)
    const initialEvaluations = resolver.mock.calls.length
    act(() =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'server' }
      }))
    )
    expect(commits).toBe(1)
    expect(resolver).toHaveBeenCalledTimes(initialEvaluations)
    act(() => useAppStore.setState((state) => ({ repos: state.repos.map((row) => ({ ...row })) })))
    expect(commits).toBe(1)
    act(() =>
      useAppStore.setState((state) => ({
        repos: [
          ...state.repos,
          adoptEndpointRepo(
            { kind: 'environment', environmentId: 'other' },
            groupRepo('unrelated', { upstream: null })
          )
        ]
      }))
    )
    expect(commits).toBe(1)
    act(() =>
      useAppStore.setState((state) => ({
        projectGroups: state.projectGroups.map((group) =>
          group.id === fixture.remoteGroup.id ? { ...group, name: 'Other remote label' } : group
        )
      }))
    )
    expect(commits).toBe(1)
    act(() =>
      useAppStore.setState((state) => ({
        repos: state.repos.map((row) =>
          row.id === 'b' ? { ...row, projectGroupId: fixture.localGroup.id } : row
        )
      }))
    )
    expect(commits).toBe(2)
    expect(selected?.grouped).toBe(true)
    expect(selected?.uniformGroupId).toBeUndefined()
    act(() =>
      useAppStore.setState((state) => ({
        projectGroups: state.projectGroups.map((group) =>
          group.id === fixture.localGroup.id ? { ...group, name: 'Current own label' } : group
        )
      }))
    )
    expect(commits).toBe(3)
    expect(screen.getByText('grouped Current own label')).toBeTruthy()
    process.stdout.write(
      `PG G selected operation ${JSON.stringify({ commits, evaluations: resolver.mock.calls.length })}\n`
    )
  } finally {
    resolver.mockRestore()
    await fixture.dispose()
  }
})
