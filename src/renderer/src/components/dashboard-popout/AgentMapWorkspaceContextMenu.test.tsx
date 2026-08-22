// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentMap } from './AgentMap'
import * as StoreSelectors from '@/store/selectors'

const NOW = 2_000_000_000
const EXECUTION_HOST_ID = 'runtime:env-1' as const
const initialState = useAppStore.getState()

const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Orca',
  badgeColor: '#000000',
  addedAt: NOW,
  kind: 'git',
  executionHostId: EXECUTION_HOST_ID
} satisfies Repo

const worktree = {
  id: 'worktree-1',
  repoId: repo.id,
  path: '/repo/worktrees/map',
  displayName: 'Agent map',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  branch: 'refs/heads/agent-map',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: NOW,
  hostId: EXECUTION_HOST_ID
} satisfies Worktree

const collidingLocalWorktree = {
  ...worktree,
  path: '/local/repo/worktrees/map',
  displayName: 'Local agent map',
  hostId: 'local'
} satisfies Worktree

const parentWorktree = {
  ...worktree,
  id: 'worktree-parent',
  path: '/repo/worktrees/parent',
  displayName: 'Parent worktree',
  branch: 'refs/heads/parent'
} satisfies Worktree

const folderProjectGroup = {
  id: 'group-1',
  name: 'Documentation',
  parentPath: '/docs',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: NOW,
  updatedAt: NOW
} satisfies ProjectGroup

const card: DashboardCard = {
  paneKey: 'pane-1',
  ptyId: 'pty-1',
  agentType: 'codex',
  bucket: 'working',
  dotState: 'working',
  task: 'Build map',
  repoId: repo.id,
  worktreeId: worktree.id,
  tabId: 'tab-1',
  leafId: 'leaf-1',
  repoName: repo.displayName,
  worktreeName: worktree.displayName,
  startedAt: NOW - 60_000,
  finishedAt: null,
  stateChangedAt: NOW - 1_000,
  unseen: false,
  workspaceKind: 'worktree'
}

describe('Agent Map workspace context menu', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree, parentWorktree] },
      detectedWorktreesByRepo: {},
      projectGroups: [],
      workspaceStatuses: [{ id: 'todo', label: 'Todo' }]
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.restoreAllMocks()
  })

  it('opens the shared sidebar workspace actions from a worktree ring', async () => {
    const useWorktreeById = vi.spyOn(StoreSelectors, 'useWorktreeById')
    render(
      <TooltipProvider>
        <AgentMap
          cards={[{ ...card, executionHostId: EXECUTION_HOST_ID }]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Agent map worktree details' }), {
      clientX: 120,
      clientY: 140
    })

    expect(await screen.findByText('Workspace', {}, { timeout: 5_000 })).toBeInTheDocument()
    expect(screen.getByText('Update')).toBeInTheDocument()
    expect(screen.getByText('Move to Status')).toBeInTheDocument()
    expect(screen.getByText('Open in')).toBeInTheDocument()
    expect(screen.getByText('Copy Path')).toBeInTheDocument()
    expect(screen.getByText('Pin')).toBeInTheDocument()
    expect(screen.getByText('Mark Unread')).toBeInTheDocument()
    expect(screen.getByText('Sleep')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(useWorktreeById).toHaveBeenCalledWith(worktree.id, EXECUTION_HOST_ID)
  })

  it('deduplicates the same host owner across known and detected worktrees', async () => {
    useAppStore.setState({
      detectedWorktreesByRepo: {
        [repo.id]: {
          repoId: repo.id,
          authoritative: true,
          source: 'git',
          worktrees: [
            { ...worktree, ownership: 'orca-managed', selectedCheckout: false, visible: true }
          ]
        }
      }
    })
    render(
      <TooltipProvider>
        <AgentMap
          cards={[{ ...card, executionHostId: EXECUTION_HOST_ID }]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Agent map worktree details' }))

    expect(await screen.findByText('Workspace', {}, { timeout: 5_000 })).toBeInTheDocument()
  })

  it('uses explicit SSH ownership instead of the paired hub repo host', async () => {
    const sshHostId = 'ssh:provider-1' as const
    const sshWorktree = { ...worktree, hostId: sshHostId }
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [sshWorktree] } })
    render(
      <TooltipProvider>
        <AgentMap
          cards={[{ ...card, executionHostId: sshHostId }]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Agent map worktree details' }))

    expect(await screen.findByText('Workspace', {}, { timeout: 5_000 })).toBeInTheDocument()
  })

  it('fails closed when bare-ID actions would span multiple execution hosts', async () => {
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [collidingLocalWorktree, worktree] }
    })
    const useWorktreeById = vi.spyOn(StoreSelectors, 'useWorktreeById')
    render(
      <TooltipProvider>
        <AgentMap
          cards={[{ ...card, executionHostId: EXECUTION_HOST_ID }]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Agent map worktree details' }))
    await waitFor(() =>
      expect(useWorktreeById).toHaveBeenCalledWith(worktree.id, EXECUTION_HOST_ID)
    )
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument()

    act(() => {
      useAppStore.setState({ worktreesByRepo: { [repo.id]: [worktree] } })
    })
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument()
  })

  it('clears a workspace request whose target disappeared', async () => {
    useAppStore.setState({ worktreesByRepo: {} })
    const useWorktreeById = vi.spyOn(StoreSelectors, 'useWorktreeById')
    render(
      <TooltipProvider>
        <AgentMap
          cards={[{ ...card, executionHostId: EXECUTION_HOST_ID }]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Agent map worktree details' }))
    await waitFor(() => expect(useWorktreeById).toHaveBeenCalled())
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    act(() => {
      useAppStore.setState({ worktreesByRepo: { [repo.id]: [worktree] } })
    })

    expect(screen.queryByText('Workspace')).not.toBeInTheDocument()
  })

  it('releases the store-backed workspace menu after an ordinary close', async () => {
    const getKnownWorktreeById = vi.fn(useAppStore.getState().getKnownWorktreeById)
    useAppStore.setState({ getKnownWorktreeById })
    render(
      <TooltipProvider>
        <AgentMap
          cards={[{ ...card, executionHostId: EXECUTION_HOST_ID }]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Agent map worktree details' }))
    expect(await screen.findByText('Workspace', {}, { timeout: 5_000 })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Workspace')).not.toBeInTheDocument())
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

    getKnownWorktreeById.mockClear()
    act(() => {
      useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    })
    expect(getKnownWorktreeById).not.toHaveBeenCalled()
  })

  it('keeps shared-menu follow-up overlays mounted through their lifecycle', async () => {
    render(
      <TooltipProvider>
        <AgentMap
          cards={[{ ...card, executionHostId: EXECUTION_HOST_ID }]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )
    const ring = screen.getByRole('button', { name: 'Open Agent map worktree details' })

    fireEvent.contextMenu(ring)
    const createGroup = await screen.findByText('New group from project', {}, { timeout: 5_000 })
    fireEvent.pointerDown(createGroup, { button: 0 })
    fireEvent.click(createGroup)
    expect(await screen.findByRole('dialog', { name: 'New Project Group' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New Project Group' })).not.toBeInTheDocument()
    )

    fireEvent.contextMenu(ring)
    const setParent = await screen.findByText('Set Parent Worktree...', {}, { timeout: 5_000 })
    fireEvent.pointerDown(setParent, { button: 0 })
    fireEvent.click(setParent)
    // Candidate rows are virtualized and measure 0 in happy-dom; the mounted
    // search input is the picker's lifecycle signal.
    expect(await screen.findByPlaceholderText('Search worktrees...')).toBeInTheDocument()
  })

  it('opens the existing worktree composer from a project ring', async () => {
    const { container } = render(
      <TooltipProvider>
        <AgentMap cards={[card]} now={NOW} workspaceContextMenusEnabled onOpenTerminal={() => {}} />
      </TooltipProvider>
    )

    fireEvent.contextMenu(container.querySelector('[data-agent-map-project]')!, {
      clientX: 100,
      clientY: 110
    })
    fireEvent.click(await screen.findByText('Create new worktree for Orca', {}, { timeout: 5_000 }))

    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toEqual({
      initialRepoId: repo.id,
      telemetrySource: 'sidebar'
    })
  })

  it('opens the folder-workspace composer from a synthetic project ring', async () => {
    useAppStore.setState({ projectGroups: [folderProjectGroup] })
    const folderCard = {
      ...card,
      repoId: `folder-workspace:${folderProjectGroup.id}`,
      repoName: folderProjectGroup.name,
      worktreeId: 'folder:folder-1',
      worktreeName: 'Docs',
      workspaceKind: 'folder' as const
    }
    const { container } = render(
      <TooltipProvider>
        <AgentMap
          cards={[folderCard]}
          now={NOW}
          workspaceContextMenusEnabled
          onOpenTerminal={() => {}}
        />
      </TooltipProvider>
    )

    fireEvent.contextMenu(container.querySelector('[data-agent-map-project]')!)
    fireEvent.click(
      await screen.findByText('Create workspace for Documentation', {}, { timeout: 5_000 })
    )

    expect(useAppStore.getState().modalData).toEqual({
      initialProjectGroupId: folderProjectGroup.id,
      telemetrySource: 'sidebar'
    })
  })

  it('clears an ambiguous project request instead of choosing a repo host', async () => {
    useAppStore.setState({
      repos: [repo, { ...repo, path: '/local/repo', executionHostId: 'local' }]
    })
    const { container } = render(
      <TooltipProvider>
        <AgentMap cards={[card]} now={NOW} workspaceContextMenusEnabled onOpenTerminal={() => {}} />
      </TooltipProvider>
    )

    fireEvent.contextMenu(container.querySelector('[data-agent-map-project]')!)
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(screen.queryByText('Create new worktree for Orca')).not.toBeInTheDocument()

    act(() => {
      useAppStore.setState({ repos: [repo] })
    })
    expect(screen.queryByText('Create new worktree for Orca')).not.toBeInTheDocument()
  })
})
