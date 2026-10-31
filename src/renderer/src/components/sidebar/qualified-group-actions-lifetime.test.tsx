// @vitest-environment happy-dom
import { groupCards, ShippingSidebar } from './qualified-notice-actions-test-fixtures'
import { groupActionFixture, groupRepo, selectGroup } from './project-group-actions-test-fixtures'
import { act } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { expect, it, vi } from 'vitest'
import { adoptEndpointRepo } from '../../../../shared/endpoint-catalog-adoption'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

it('keeps a pinned duplicate Q child under P in its own exact project and does not multiply saved targets', async () => {
  const fixture = await groupActionFixture({
    localRepos: [
      groupRepo('p'),
      groupRepo('q', { displayName: 'Quay', upstream: { owner: 'org', repo: 'quay' } }),
      groupRepo('q-second', { displayName: 'Quay', upstream: { owner: 'org', repo: 'quay' } })
    ]
  })
  groupCards.shipping = true
  const user = userEvent.setup()
  try {
    act(() =>
      useAppStore.setState((state) => {
        const parent = {
          ...state.worktreesByRepo.p![0]!,
          instanceId: 'parent-instance',
          isPinned: true
        }
        const child = { ...state.worktreesByRepo.q![0]!, instanceId: 'child-instance' }
        return {
          settings: { ...state.settings!, showPinnedWorktreesInGroups: true },
          worktreesByRepo: { ...state.worktreesByRepo, p: [parent], q: [child] },
          worktreeLineageById: {
            [child.id]: {
              worktreeId: child.id,
              worktreeInstanceId: child.instanceId,
              parentWorktreeId: parent.id,
              parentWorktreeInstanceId: parent.instanceId,
              origin: 'manual',
              capture: { source: 'manual-action', confidence: 'explicit' },
              createdAt: 1
            }
          }
        }
      })
    )
    render(<ShippingSidebar />)
    const occurrences = screen.getAllByText('q checkout')
    expect(occurrences).toHaveLength(2)
    await user.pointer({ target: occurrences[0]!, keys: '[MouseRight]' })
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(fixture.moves).toHaveLength(2))
    expect(fixture.moves.map((move) => move.id)).toEqual(['q', 'q-second'])
    expect(
      (await fixture.saved()).local.map((row) => [row.id, row.projectGroupId ?? null])
    ).toEqual([
      ['p', null],
      ['q', fixture.localGroup.id],
      ['q-second', fixture.localGroup.id]
    ])
  } finally {
    await fixture.dispose()
  }
})

it('keeps accepted original scope through late members, mode/focus/rank changes and fences an older Move remainder after newer null acceptance', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b')],
    remoteRepos: [groupRepo('c')]
  })
  const user = userEvent.setup()
  let release: (() => void) | undefined
  try {
    render(<ShippingSidebar />)
    fixture.intercept(async (_catalog, id, groupId) => {
      if (id === 'a' && groupId) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(release).toBeTypeOf('function'))
    const late = groupRepo('late')
    fixture.localDisk.addRepo(late)
    act(() =>
      useAppStore.setState((state) => {
        const repos = [state.repos[1]!, late, state.repos[0]!, ...state.repos.slice(2)]
        const projected = projectHostSetupProjectionFromRepos(repos)
        return {
          repos,
          projects: projected.projects,
          projectHostSetups: projected.setups,
          settings: {
            ...state.settings!,
            projectGroupingMode: 'folder',
            activeRuntimeEnvironmentId: 'server'
          }
        }
      })
    )
    await act(async () => {
      release?.()
    })
    await waitFor(() =>
      expect(fixture.localDisk.getRepo('b')?.projectGroupId).toBe(fixture.localGroup.id)
    )
    expect(fixture.moves.map((move) => move.id)).toEqual(['a', 'b'])
    expect(fixture.localDisk.getRepo('late')?.projectGroupId ?? null).toBeNull()
    expect(fixture.remoteDisk.getRepo('c')?.projectGroupId ?? null).toBeNull()
    fixture.intercept()
    // Restore the current presentation, then accept a finite New destination move and a newer null command.
    act(() =>
      useAppStore.setState((state) => {
        const order = ['a', 'b', 'late', 'c']
        const repos = [...state.repos].sort(
          (left, right) => order.indexOf(left.id) - order.indexOf(right.id)
        )
        const projected = projectHostSetupProjectionFromRepos(repos)
        return {
          repos,
          projects: projected.projects,
          projectHostSetups: projected.setups,
          settings: { ...state.settings!, projectGroupingMode: 'repository' }
        }
      })
    )
    const next = fixture.localDisk.createProjectGroup({
      name: 'Next destination',
      createdFrom: 'manual'
    })
    act(() => useAppStore.setState((state) => ({ projectGroups: [...state.projectGroups, next] })))
    fixture.moves.length = 0
    release = undefined
    fixture.intercept(async (_catalog, id, groupId) => {
      if (id === 'a' && groupId === next.id) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await selectGroup(user, 'Next destination')
    await waitFor(() => expect(release).toBeTypeOf('function'))
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove from group' }))
    await waitFor(() => expect(fixture.localDisk.getRepo('b')?.projectGroupId).toBeNull())
    await act(async () => {
      release?.()
    })
    await waitFor(() =>
      expect(useAppStore.getState().repos.find((row) => row.id === 'a')?.projectGroupId).toBe(
        next.id
      )
    )
    expect(fixture.moves.map((move) => [move.id, move.groupId])).toEqual([
      ['a', next.id],
      ['a', null],
      ['b', null]
    ])
    const saved = await fixture.saved()
    expect(saved.local.map((row) => row.projectGroupId ?? null)).toEqual([next.id, null, null])
  } finally {
    release?.()
    await fixture.dispose()
  }
})

it('uses the hostless local placement registration catalog despite foreign focus and offers only its own equal-ID destination copy', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b')],
    remoteRepos: [groupRepo('c'), groupRepo('d')],
    equalIdDestination: true
  })
  const user = userEvent.setup()
  try {
    expect(fixture.remoteGroup.id).toBe(fixture.localGroup.id)
    act(() =>
      useAppStore.setState((state) => ({
        repos: state.repos.map((row) =>
          getRepoExecutionHostId(row) === 'local' ? { ...row, executionHostId: undefined } : row
        ),
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'server' }
      }))
    )
    render(<ShippingSidebar />)
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.hover(screen.getByRole('menuitem', { name: 'Move to group' }))
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Local destination' })).toBeTruthy()
    )
    expect(screen.queryByRole('menuitem', { name: 'Remote equal-ID destination' })).toBeNull()
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(fixture.moves).toHaveLength(2))
    expect(fixture.moves.map((move) => [move.catalog, move.id])).toEqual([
      ['local', 'a'],
      ['local', 'b']
    ])
    expect((await fixture.saved()).remote.every((row) => !row.projectGroupId)).toBe(true)
    // Across-catalog raw reanchor changes the header's catalog without changing either saved membership.
    act(() =>
      useAppStore.setState((state) => ({
        repos: [...state.repos.slice(2), ...state.repos.slice(0, 2)]
      }))
    )
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.hover(screen.getByRole('menuitem', { name: 'Move to group' }))
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Remote equal-ID destination' })).toBeTruthy()
    )
    expect(screen.queryByRole('menuitem', { name: 'Local destination' })).toBeNull()
    await user.keyboard('{Escape}{Escape}')
    expect(fixture.moves).toHaveLength(2)
  } finally {
    await fixture.dispose()
  }
})

it('stops after the confirmed prefix when an original source disappears and a foreign same-ID registration arrives', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b'), groupRepo('last')]
  })
  const user = userEvent.setup()
  const feedback = vi.spyOn(toast, 'error')
  let release: (() => void) | undefined
  try {
    fixture.intercept(async (_catalog, id) => {
      if (id === 'a') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    render(<ShippingSidebar />)
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(release).toBeTypeOf('function'))
    fixture.localDisk.removeProjectForHost({ id: 'b', executionHostId: 'local' })
    act(() =>
      useAppStore.setState((state) => ({
        repos: [
          ...state.repos.filter((row) => row.id !== 'b'),
          adoptEndpointRepo({ kind: 'environment', environmentId: 'server' }, groupRepo('b'))
        ]
      }))
    )
    await act(async () => {
      release?.()
    })
    await waitFor(() => expect(feedback).toHaveBeenCalledTimes(1))
    expect(feedback).toHaveBeenCalledWith('Could not move project to group')
    expect(fixture.moves.map((move) => move.id)).toEqual(['a'])
    const saved = await fixture.saved()
    expect(saved.local.map((row) => [row.id, row.projectGroupId ?? null])).toEqual([
      ['a', fixture.localGroup.id],
      ['last', null]
    ])
    expect(
      useAppStore.getState().repos.find((row) => row.id === 'b')?.projectGroupId ?? null
    ).toBeNull()
  } finally {
    release?.()
    feedback.mockRestore()
    await fixture.dispose()
  }
})

it('completes row New through the existing list dialog lifetime while its first saved membership reparents the clicked card', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b'), groupRepo('last')]
  })
  groupCards.shipping = true
  const user = userEvent.setup()
  try {
    render(<ShippingSidebar />)
    await user.pointer({ target: screen.getByText('b checkout'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fixture.moves).toHaveLength(3))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fixture.createLocal).toHaveBeenCalledTimes(1)
    const saved = await fixture.saved()
    expect(saved.local.every((row) => row.projectGroupId === saved.local[0]?.projectGroupId)).toBe(
      true
    )
    expect(fixture.moves.map((move) => move.id)).toEqual(['a', 'b', 'last'])
  } finally {
    await fixture.dispose()
  }
})
