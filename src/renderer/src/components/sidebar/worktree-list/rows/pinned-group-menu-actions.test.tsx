// @vitest-environment happy-dom
import { useWorktreePinnedGroupMenu } from '../../workspace-actions/context-menu/use-worktree-pinned-group-menu'
import { makeLineage } from '../../../../store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { PinnedGroupHeaderMenu } from './PinnedGroupHeaderMenu'
import { PinnedWorktreeGroupMenuItems } from '../../workspace-actions/context-menu/PinnedWorktreeGroupMenuItems'

vi.mock('@/components/ui/dropdown-menu', () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    DropdownMenu: Container,
    DropdownMenuTrigger: Container,
    DropdownMenuContent: Container,
    DropdownMenuSub: Container,
    DropdownMenuSubTrigger: Container,
    DropdownMenuSubContent: Container,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled
    }: {
      children?: ReactNode
      onSelect?: () => void
      disabled?: boolean
    }) => (
      <button disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    )
  }
})
vi.mock('./ProjectGroupNameDialog', () => ({
  ProjectGroupNameDialog: ({
    open,
    onSubmit
  }: {
    open: boolean
    onSubmit: (name: string) => Promise<void>
  }) =>
    open ? (
      <button
        onClick={() => {
          void onSubmit('Stewards')
        }}
      >
        Submit name
      </button>
    ) : null
}))
vi.mock('../../../../../../shared/non-secure-context-uuid', () => ({
  createNonSecureContextUuid: () => 'new-group'
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const initial = useAppStore.getInitialState()
const save = vi.fn(async () => {})
beforeEach(() => {
  save.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/me'),
      pinnedGroups: [
        { id: 'fleet', name: 'Fleet', order: 0 },
        { id: 'later', name: 'Later', order: 1 }
      ],
      pinnedGroupByWorktreeIdentity: { 'local|wt-1': 'fleet', 'runtime:orion|wt-1': 'later' }
    },
    updateSettingsOrThrow: save
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

function itemMenu() {
  return render(
    <PinnedWorktreeGroupMenuItems
      model={{
        pinnedGroupWorktree: { ...worktree, hostId: 'local', isPinned: true },
        pinnedGroups: useAppStore.getState().settings?.pinnedGroups,
        pinnedGroupByWorktreeIdentity:
          useAppStore.getState().settings?.pinnedGroupByWorktreeIdentity,
        isDeleting: false,
        handleCreatePinnedGroup: vi.fn()
      }}
    />
  )
}

it('adds the clicked host copy to the selected group', async () => {
  fireEvent.click(itemMenu().getByRole('button', { name: 'Later' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      pinnedGroupByWorktreeIdentity: { 'local|wt-1': 'later', 'runtime:orion|wt-1': 'later' }
    })
  )
})

it('removes only the clicked host copy from its group', async () => {
  fireEvent.click(itemMenu().getByRole('button', { name: 'Remove from group' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      pinnedGroupByWorktreeIdentity: { 'runtime:orion|wt-1': 'later' }
    })
  )
})

it('renames the selected group through the naming dialog', async () => {
  const view = render(<PinnedGroupHeaderMenu groupId="fleet" label="Fleet" />)
  fireEvent.click(view.getByRole('button', { name: 'Rename group' }))
  fireEvent.click(view.getByRole('button', { name: 'Submit name' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      pinnedGroups: [
        { id: 'fleet', name: 'Stewards', order: 0 },
        { id: 'later', name: 'Later', order: 1 }
      ]
    })
  )
})

it('moves a group down and persists its new order', async () => {
  const view = render(<PinnedGroupHeaderMenu groupId="fleet" label="Fleet" />)
  fireEvent.click(view.getByRole('button', { name: 'Move down' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      pinnedGroups: [
        { id: 'later', name: 'Later', order: 0 },
        { id: 'fleet', name: 'Fleet', order: 1 }
      ]
    })
  )
})

it('moves a group up and persists its new order', async () => {
  const view = render(<PinnedGroupHeaderMenu groupId="later" label="Later" />)
  fireEvent.click(view.getByRole('button', { name: 'Move up' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      pinnedGroups: [
        { id: 'later', name: 'Later', order: 0 },
        { id: 'fleet', name: 'Fleet', order: 1 }
      ]
    })
  )
})

it('removes a group and its membership without unpinning worktrees', async () => {
  const view = render(<PinnedGroupHeaderMenu groupId="fleet" label="Fleet" />)
  fireEvent.click(view.getByRole('button', { name: 'Remove group' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      pinnedGroups: [{ id: 'later', name: 'Later', order: 1 }],
      pinnedGroupByWorktreeIdentity: { 'runtime:orion|wt-1': 'later' }
    })
  )
})

it('creates a group for the pinned ancestor after the descendant menu closes', async () => {
  const parent = {
    ...worktree,
    id: 'parent',
    hostId: 'local' as const,
    isPinned: true,
    instanceId: 'parent-instance'
  }
  const child = { ...worktree, id: 'child', hostId: 'local' as const, instanceId: 'child-instance' }
  const worktrees = [parent, child]
  const worktreeMap = new Map(worktrees.map((row) => [row.id, row]))
  const lineage = { child: makeLineage({ worktreeId: 'child', parentWorktreeId: 'parent' }) }
  const openNameDialog = vi.fn()
  const { result, rerender } = renderHook(
    ({ menuOpen }) =>
      useWorktreePinnedGroupMenu({
        worktree: child,
        menuOpen,
        allWorktrees: worktrees,
        worktreeMap,
        worktreeLineageById: lineage,
        projectGroupCommands: {
          handleCreateGroupDialogOpenChange: openNameDialog,
          handleCreateGroupFromRepo: vi.fn(),
          handleSubmitNewProjectGroup: vi.fn()
        }
      }),
    { initialProps: { menuOpen: true } }
  )
  act(() => result.current.handleCreatePinnedGroup())
  expect(openNameDialog).toHaveBeenCalledWith(true)
  rerender({ menuOpen: false })
  await act(() => result.current.handleSubmitNewProjectGroup('Team'))
  expect(save).toHaveBeenCalledWith({
    pinnedGroups: [
      { id: 'fleet', name: 'Fleet', order: 0 },
      { id: 'later', name: 'Later', order: 1 },
      { id: 'new-group', name: 'Team', order: 2 }
    ],
    pinnedGroupByWorktreeIdentity: {
      'local|wt-1': 'fleet',
      'runtime:orion|wt-1': 'later',
      'local|parent': 'new-group'
    }
  })
})
