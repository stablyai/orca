// @vitest-environment happy-dom
import { groupCards, ShippingSidebar } from './qualified-notice-actions-test-fixtures'
import { groupActionFixture, groupRepo, selectGroup } from './project-group-actions-test-fixtures'
import { act } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { buildProjectGroupingIndex } from '../../../../shared/project-section-grouping'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'

import { toast } from 'sonner'
import { withRepoHostOwnership } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { worktree } from './worktree-list-groups-test-fixtures'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
it('joins the shipping header/group owner to exact real persistence, mixed predicates, null, late receiving refusal and reload/reanchor', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b')],
    remoteRepos: [groupRepo('c'), groupRepo('d')]
  })
  const user = userEvent.setup()
  try {
    render(<ShippingSidebar />)
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.hover(screen.getByRole('menuitem', { name: 'Move to group' }))
    expect(screen.queryByRole('menuitem', { name: 'Remote destination' })).toBeNull()
    await selectGroup(user, 'Local destination')
    try {
      await waitFor(() => expect(fixture.moves).toHaveLength(2))
    } finally {
      const saved = await fixture.saved()
      process.stdout.write(
        `PG G header saved tuples ${JSON.stringify({ moves: fixture.moves, local: saved.local.map((entry) => [entry.id, entry.projectGroupId ?? null]), remote: saved.remote.map((entry) => [entry.id, entry.projectGroupId ?? null]) })}\n`
      )
    }
    expect(fixture.moves).toEqual([
      { catalog: 'local', id: 'a', groupId: fixture.localGroup.id },
      { catalog: 'local', id: 'b', groupId: fixture.localGroup.id }
    ])
    expect((await fixture.saved()).local.map((entry) => entry.projectGroupId)).toEqual([
      fixture.localGroup.id,
      fixture.localGroup.id
    ])
    expect((await fixture.saved()).remote.every((entry) => !entry.projectGroupId)).toBe(true)
    const unchangedRank = fixture.localDisk.getRepo('a')!.projectGroupOrder
    // A remains correct while B becomes mixed; the actual menu must offer completing B.
    fixture.localDisk.moveProjectToGroup({ id: 'b', executionHostId: 'local' }, null)
    act(() =>
      useAppStore.setState((state) => ({
        repos: state.repos.map((entry) =>
          entry.id === 'b' ? { ...entry, projectGroupId: null } : entry
        )
      }))
    )
    fixture.moves.length = 0
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(fixture.moves).toHaveLength(1))
    expect(fixture.moves[0]?.id).toBe('b')
    expect(fixture.localDisk.getRepo('a')!.projectGroupOrder).toBe(unchangedRank)
    fixture.moves.length = 0
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove from group' }))
    await waitFor(() => expect(fixture.moves).toHaveLength(2))
    expect((await fixture.saved()).local.every((entry) => entry.projectGroupId === null)).toBe(true)
    fixture.moves.length = 0
    fixture.intercept(async (_catalog, id, groupId) => {
      if (id === 'a' && groupId) {
        fixture.localDisk.deleteProjectGroup(groupId)
      }
    })
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(fixture.moves).toHaveLength(1))
    expect((await fixture.saved()).local.every((entry) => entry.projectGroupId === null)).toBe(true)
    expect(fixture.localDisk.getRepo('a')?.projectGroupOrder).toBe(0)
    // Replan the actual saved membership using the opposite registration's placement order.
    act(() =>
      useAppStore.setState((state) => ({
        repos: [state.repos[1]!, state.repos[0]!, ...state.repos.slice(2)],
        settings: { ...state.settings!, projectGroupingMode: 'folder' }
      }))
    )
    expect(
      buildProjectGroupingIndex(getProjectGroupingModelFromState(useAppStore.getState())).groups
    ).toHaveLength(4)
  } finally {
    await fixture.dispose()
  }
})

it('keeps actual card commands in the clicked checkout catalog below another header and with none/status/PR/board presentation', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b')],
    remoteRepos: [groupRepo('c'), groupRepo('d')]
  })
  groupCards.shipping = true
  const user = userEvent.setup()
  try {
    const rendered = render(<ShippingSidebar />)
    for (const presentation of [
      'repo',
      'none',
      'workspace-status',
      'pr-status',
      'board'
    ] as const) {
      act(() =>
        useAppStore.setState({
          groupBy: presentation === 'board' ? 'workspace-status' : presentation
        })
      )
      rendered.rerender(<ShippingSidebar board={presentation === 'board'} />)
      const title = screen.getAllByText('c checkout')[0]!
      await user.pointer({ target: title, keys: '[MouseRight]' })
      screen.getByRole('menuitem', { name: 'Move to group' }).focus()
      await user.keyboard('{ArrowRight}')
      await waitFor(() =>
        expect(screen.getByRole('menuitem', { name: 'Remote destination' })).toBeTruthy()
      )
      expect(screen.queryByRole('menuitem', { name: 'Local destination' })).toBeNull()
      if (presentation === 'repo') {
        await selectGroup(user, 'Remote destination')
        await waitFor(() => expect(fixture.moves).toHaveLength(2))
        expect(fixture.moves.map((move) => [move.catalog, move.id])).toEqual([
          ['remote', 'c'],
          ['remote', 'd']
        ])
        expect((await fixture.saved()).local.every((entry) => !entry.projectGroupId)).toBe(true)
      } else {
        expect(
          screen.getByRole('menuitem', { name: 'Remote destination' }).getAttribute('data-disabled')
        ).not.toBeNull()
        await user.keyboard('{Escape}{Escape}')
      }
    }
  } finally {
    await fixture.dispose()
  }
})

it('uses the actual runtime host-copy New dialog once and retains its ID on failed member retry, without incomplete closure', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('a'), groupRepo('b')],
    remoteRepos: [groupRepo('c'), groupRepo('d'), groupRepo('e')]
  })
  const user = userEvent.setup()
  try {
    act(() => useAppStore.setState({ workspaceHostScope: 'runtime:server' }))
    // Actual host filtering/localization, rather than passing a desired runtime member array.
    render(<ShippingSidebar />)
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    let failD = true
    fixture.intercept(async (_catalog, id) => {
      if (id === 'd' && failD) {
        throw new Error('transport unavailable')
      }
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await user.click(screen.getByRole('button', { name: 'Create' }))
      await waitFor(() => expect(fixture.moves).toHaveLength(2))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', false)
      )
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(fixture.createRemote).toHaveBeenCalledTimes(1)
      expect(fixture.createLocal).not.toHaveBeenCalled()
      const created = fixture.createRemote.mock.results[0]!.value
      expect(fixture.remoteDisk.getRepo('c')?.projectGroupId).toBe(created.id)
      expect(fixture.remoteDisk.getRepo('d')?.projectGroupId ?? null).toBeNull()
      failD = false
      await user.click(screen.getByRole('button', { name: 'Create' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(fixture.createRemote).toHaveBeenCalledTimes(1)
      expect(fixture.moves.map((move) => move.id)).toEqual(['c', 'd', 'd', 'e'])
      expect((await fixture.saved()).remote.map((entry) => entry.projectGroupId)).toEqual([
        created.id,
        created.id,
        created.id
      ])
    } finally {
      quiet.mockRestore()
    }
  } finally {
    await fixture.dispose()
  }
})

it('keeps row New bound to its captured own name and draft through foreign, equal and focus publications, including a pending save', async () => {
  const fixture = await groupActionFixture({
    localRepos: [groupRepo('r'), groupRepo('b')],
    remoteRepos: [groupRepo('r', { displayName: 'Quay' })]
  })
  groupCards.shipping = true
  const user = userEvent.setup()
  let release: (() => void) | undefined
  try {
    const legacy = withRepoHostOwnership(
      { ...worktree, id: 'legacy', repoId: 'r', displayName: 'legacy local checkout' },
      'local'
    )
    expect(legacy).not.toHaveProperty('hostId')
    act(() =>
      useAppStore.setState((state) => ({
        activeRepoId: 'b',
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'unrelated' },
        worktreesByRepo: { r: [legacy] }
      }))
    )
    render(<ShippingSidebar />)
    await user.pointer({ target: screen.getByText('legacy local checkout'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    const dialog = screen.getByRole('dialog')
    expect(useAppStore.getState().activeRepoId).toBe('b')
    const input = screen.getByRole('textbox', { name: 'Group Name' })
    expect(input).toHaveProperty('value', 'Harbor group')
    await user.clear(input)
    await user.type(input, 'My Harbor group')
    const publishForeignName = (displayName: string) => {
      act(() =>
        useAppStore.setState((state) => ({
          repos: state.repos.map((entry) =>
            getRepoExecutionHostId(entry) === 'runtime:server' ? { ...entry, displayName } : entry
          )
        }))
      )
    }
    publishForeignName('Other Quay')
    act(() =>
      useAppStore.setState((state) => ({ repos: state.repos.map((entry) => ({ ...entry })) }))
    )
    act(() =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'server' }
      }))
    )
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('textbox', { name: 'Group Name' })).toBe(input)
    expect(input).toHaveProperty('value', 'My Harbor group')
    fixture.intercept(async (_catalog, id) => {
      if (id === 'r') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    publishForeignName('Latest Quay')
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(input).toHaveProperty('value', 'My Harbor group')
    expect(screen.getByRole('button', { name: 'Saving...' })).toHaveProperty('disabled', true)
    expect(fixture.createLocal).toHaveBeenCalledTimes(1)
    expect(fixture.createLocal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My Harbor group' })
    )
    expect(fixture.createRemote).not.toHaveBeenCalled()
    await act(async () => release?.())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fixture.moves.map((move) => [move.catalog, move.id])).toEqual([
      ['local', 'r'],
      ['local', 'b']
    ])
    const created = await fixture.createLocal.mock.results[0]!.value
    const saved = await fixture.saved()
    expect(saved.local.map((entry) => entry.projectGroupId)).toEqual([created.id, created.id])
    expect(saved.remote[0]?.projectGroupId ?? null).toBeNull()
    expect(fixture.createLocal).toHaveBeenCalledTimes(1)
  } finally {
    release?.()
    await fixture.dispose()
  }
})

it('retains producer-backed legacy local meaning beside a foreign same-ID row and resolves adopted connection-cleared nested setups by actual containment', async () => {
  const user = userEvent.setup()
  const localFixture = await groupActionFixture({
    localRepos: [groupRepo('r'), groupRepo('b')],
    remoteRepos: [groupRepo('r')]
  })
  groupCards.shipping = true
  try {
    const legacy = withRepoHostOwnership(
      { ...worktree, id: 'legacy', repoId: 'r', displayName: 'legacy local checkout' },
      'local'
    )
    expect(legacy).not.toHaveProperty('hostId')
    act(() =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'unrelated' },
        worktreesByRepo: { r: [legacy] }
      }))
    )
    render(<ShippingSidebar />)
    await user.pointer({ target: screen.getByText('legacy local checkout'), keys: '[MouseRight]' })
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(localFixture.moves).toHaveLength(2))
    expect(localFixture.moves.map((move) => [move.catalog, move.id])).toEqual([
      ['local', 'r'],
      ['local', 'b']
    ])
    expect((await localFixture.saved()).remote[0]?.projectGroupId ?? null).toBeNull()
  } finally {
    await localFixture.dispose()
  }
  useAppStore.setState(useAppStore.getInitialState(), true)
  const nested = await groupActionFixture({
    localRepos: [],
    remoteRepos: [
      groupRepo('r', { connectionId: 'x' }),
      groupRepo('r', { connectionId: 'y', path: '/r-y' }),
      groupRepo('q', { connectionId: 'y' })
    ],
    mode: 'host'
  })
  try {
    const setupX = useAppStore
      .getState()
      .projectHostSetups.find((setup) => setup.repoId === 'r' && setup.executionHostId === 'ssh:x')!
    expect(setupX).toMatchObject({
      hostId: 'runtime:server',
      executionHostId: 'ssh:x',
      connectionId: null,
      runtimeOwnerEnvironmentId: 'server'
    })
    const producer = withRepoHostOwnership(
      {
        ...worktree,
        id: 'nested-x',
        repoId: 'r',
        displayName: 'nested x checkout',
        hostId: 'ssh:x' as const
      },
      'runtime:server',
      setupX
    )
    act(() => useAppStore.setState({ worktreesByRepo: { r: [producer] } }))
    const current = buildProjectGroupingIndex(
      getProjectGroupingModelFromState(useAppStore.getState())
    )
    const groups = current.groups.map((group) =>
      group.registrations.map((setup) => [setup.repoId, setup.executionHostId])
    )
    expect(groups).toEqual([
      [['r', 'ssh:x']],
      [
        ['r', 'ssh:y'],
        ['q', 'ssh:y']
      ]
    ])
    render(<ShippingSidebar />)
    await user.pointer({ target: screen.getByText('nested x checkout'), keys: '[MouseRight]' })
    await selectGroup(user, 'Remote destination')
    await waitFor(() => expect(nested.moves).toHaveLength(1))
    expect(
      (await nested.saved()).remote.map((entry) => [
        entry.id,
        entry.connectionId,
        entry.projectGroupId ?? null
      ])
    ).toEqual([
      ['r', 'x', nested.remoteGroup.id],
      ['r', 'y', null],
      ['q', 'y', null]
    ])
  } finally {
    await nested.dispose()
  }
})

it('keeps supplied H independent of a rejected raw placement Repo and excludes its unrelated logical project', async () => {
  const fixture = await groupActionFixture({
    localRepos: [
      groupRepo('same'),
      groupRepo('b'),
      groupRepo('same', {
        connectionId: 'box',
        path: '/foreign',
        upstream: { owner: 'org', repo: 'other' },
        displayName: 'Other'
      })
    ]
  })
  const user = userEvent.setup()
  try {
    render(<ShippingSidebar />)
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await selectGroup(user, 'Local destination')
    await waitFor(() => expect(fixture.moves).toHaveLength(2))
    expect(
      (await fixture.saved()).local.map((entry) => [
        entry.id,
        entry.connectionId ?? null,
        entry.projectGroupId ?? null
      ])
    ).toEqual([
      ['same', null, fixture.localGroup.id],
      ['b', null, fixture.localGroup.id],
      ['same', 'box', null]
    ])
  } finally {
    await fixture.dispose()
  }
})

it('fences an old card New continuation and dialog completion when closed and reopened through the header owner', async () => {
  const fixture = await groupActionFixture({ localRepos: [groupRepo('a'), groupRepo('b')] })
  groupCards.shipping = true
  const user = userEvent.setup()
  let release: (() => void) | undefined
  try {
    fixture.intercept(async (_catalog, id) => {
      if (id === 'a' && !release) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    render(<ShippingSidebar />)
    await user.pointer({ target: screen.getByText('b checkout'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    await user.clear(screen.getByRole('textbox', { name: 'Group Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Group Name' }), 'Old row draft')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    const oldGroup = fixture.createLocal.mock.results[0]!.value
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    const successor = screen.getByRole('dialog')
    expect(screen.getByRole('textbox', { name: 'Group Name' })).toHaveProperty(
      'value',
      'Harbor group'
    )
    await user.clear(screen.getByRole('textbox', { name: 'Group Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Group Name' }), 'Successor group')
    await act(async () => {
      release?.()
    })
    await waitFor(() => expect(fixture.localDisk.getRepo('a')?.projectGroupId).toBeDefined())
    expect(screen.getByRole('dialog')).toBe(successor)
    expect(screen.getByRole('textbox', { name: 'Group Name' })).toHaveProperty(
      'value',
      'Successor group'
    )
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', false)
    expect(fixture.moves.map((move) => move.id)).toEqual(['a'])
    expect(fixture.localDisk.getRepo('b')?.projectGroupId ?? null).toBeNull()
    expect(oldGroup).toBeDefined()
    fixture.intercept()
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fixture.createLocal).toHaveBeenCalledTimes(2)
    expect(fixture.createLocal.mock.calls.map(([args]) => args.name)).toEqual([
      'Old row draft',
      'Successor group'
    ])
    expect(fixture.moves.map((move) => move.id)).toEqual(['a', 'a', 'b'])
    const result = await fixture.saved()
    expect(result.local[0]?.projectGroupId).toBe(result.local[1]?.projectGroupId)
  } finally {
    release?.()
    await fixture.dispose()
  }
})

it('prevalidates finite original sources before New, keeps create failure in the real failed-submit path, and does not recreate an unconfirmed attempt', async () => {
  const fixture = await groupActionFixture({ localRepos: [groupRepo('a'), groupRepo('b')] })
  const user = userEvent.setup()
  const feedback = vi.spyOn(toast, 'error')
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(<ShippingSidebar />)
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    act(() =>
      useAppStore.setState((state) => ({ repos: state.repos.filter((entry) => entry.id !== 'b') }))
    )
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(fixture.createLocal).not.toHaveBeenCalled()
    expect(fixture.moves).toEqual([])
    expect(feedback).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    act(() => useAppStore.setState({ repos: fixture.repos }))
    fixture.createLocal.mockRejectedValueOnce(new Error('create disconnected'))
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', false)
    )
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(fixture.createLocal).toHaveBeenCalledTimes(1)
    expect(fixture.moves).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'New group from project' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fixture.createLocal).toHaveBeenCalledTimes(2)
    expect((await fixture.saved()).local[0]?.projectGroupId).toBe(
      (await fixture.saved()).local[1]?.projectGroupId
    )
  } finally {
    feedback.mockRestore()
    quiet.mockRestore()
    await fixture.dispose()
  }
})

it.each([
  ['tuple', 'success'],
  ['tuple', 'false'],
  ['tuple', 'reject'],
  ['reopen', 'success'],
  ['reopen', 'false'],
  ['reopen', 'reject']
] as const)(
  'fences old %s session %s settlement while the same dialog successor saves',
  async (transition, outcome) => {
    const pending: { resolve: (value: boolean) => void; reject: (error: Error) => void }[] = []
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          pending.push({ resolve, reject })
        })
    )
    const onOpenChange = vi.fn()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sessionKey = {}
    const props = {
      open: true,
      initialName: 'Alpha',
      sessionKey,
      title: 'Name project group',
      description: 'Choose a group name.',
      confirmLabel: 'Save',
      onOpenChange,
      onSubmit
    }
    const rendered = render(<ProjectGroupNameDialog {...props} />)
    const user = userEvent.setup()
    try {
      const originalInput = screen.getByRole('textbox', { name: 'Group Name' })
      expect(document.activeElement).toBe(originalInput)
      expect(originalInput).toHaveProperty('selectionStart', 0)
      expect(originalInput).toHaveProperty('selectionEnd', 5)
      await user.clear(originalInput)
      await user.type(originalInput, 'Old draft')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onSubmit).toHaveBeenNthCalledWith(1, 'Old draft')
      expect(originalInput).toHaveProperty('disabled', false)
      await user.type(originalInput, ' edited')
      expect(originalInput).toHaveProperty('value', 'Old draft edited')
      if (transition === 'tuple') {
        rendered.rerender(<ProjectGroupNameDialog {...props} initialName="Beta" sessionKey={{}} />)
        expect(screen.getByRole('textbox', { name: 'Group Name' })).toBe(originalInput)
        expect(originalInput).toHaveProperty('value', 'Beta')
      } else {
        rendered.rerender(<ProjectGroupNameDialog {...props} open={false} />)
        expect(screen.queryByRole('dialog')).toBeNull()
      }
      rendered.rerender(<ProjectGroupNameDialog {...props} />)
      const input = screen.getByRole('textbox', { name: 'Group Name' })
      const dialog = screen.getByRole('dialog')
      expect(input).toHaveProperty('value', 'Alpha')
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
      await user.clear(input)
      await user.type(input, 'Successor draft')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onSubmit).toHaveBeenNthCalledWith(2, 'Successor draft')
      await act(async () => {
        if (outcome === 'reject') {
          pending[0]!.reject(new Error('Old save failed'))
        } else {
          pending[0]!.resolve(outcome === 'success')
        }
      })
      expect(onOpenChange).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog')).toBe(dialog)
      expect(screen.getByRole('textbox', { name: 'Group Name' })).toBe(input)
      expect(input).toHaveProperty('value', 'Successor draft')
      expect(screen.getByRole('button', { name: 'Saving...' })).toHaveProperty('disabled', true)
      await act(async () => {
        if (outcome === 'reject') {
          pending[1]!.reject(new Error('Current save failed'))
        } else {
          pending[1]!.resolve(outcome === 'success')
        }
      })
      if (outcome !== 'success') {
        expect(onOpenChange).not.toHaveBeenCalled()
        expect(input).toHaveProperty('value', 'Successor draft')
        expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
        await user.click(screen.getByRole('button', { name: 'Save' }))
        expect(onSubmit).toHaveBeenNthCalledWith(3, 'Successor draft')
        await act(async () => pending[2]!.resolve(true))
      }
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
      expect(quiet).toHaveBeenCalledTimes(outcome === 'reject' ? 2 : 0)
    } finally {
      rendered.unmount()
      quiet.mockRestore()
    }
  }
)
