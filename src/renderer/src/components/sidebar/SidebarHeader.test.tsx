// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidebarHeader from './SidebarHeader'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { makeFolderWorkspace, makeProjectGroup } from './folder-workspace-composer-submit-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => {
  const popoverContentProps: { current: Record<string, unknown> | null } = { current: null }
  const shortcutLabel: { current: string | null } = { current: '⌘N' }

  return {
    bucketCounts: { attention: 0, working: 0, done: 0, idle: 0 },
    openWorkspaceCreationComposerWithTourHandoff: vi.fn(),
    activateAndRevealFolderWorkspace: vi.fn(),
    createFolderWorkspace: vi.fn(),
    toastError: vi.fn(),
    runBackgroundWorktreeCreation: vi.fn(),
    popoverContentProps,
    shortcutLabel,
    toast: vi.fn()
  }
})

type MockState = {
  repos: {
    id: string
    kind?: string
    projectGroupId?: string
    path?: string
    connectionId?: string
  }[]
  activeWorktreeId: string | null
  activeWorkspaceKey: string | null
  activeWorkspaceExecutionHostId: string | null
  activeRepoId: string | null
  folderWorkspaces: FolderWorkspace[]
  projectGroups: ProjectGroup[]
  createFolderWorkspace: typeof mocks.createFolderWorkspace
  runtimeStatusByEnvironmentId: Map<string, never>
  groupBy: string
  sidebarBody: 'workspaces' | 'agents'
  sidebarWidth: number
  setSidebarBody: (body: 'workspaces' | 'agents') => void
  openModal: (modal: string, data?: unknown) => void
  closeModal: () => void
  activeModal: 'none' | 'add-repo'
  worktreesByRepo: Record<string, { id: string; repoId: string; path: string }[]>
  updateSettings: (patch: Record<string, unknown>) => void
  activeContextualTourId: string | null
  settings?: {
    experimentalAgentDashboardPopout?: boolean
    agentsSidebarIntroShown?: boolean
    agentsSidebarMigratedFromExperimental?: boolean
  }
}

let mockState: MockState

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: MockState) => unknown) => selector(mockState)
  useAppStore.getState = () => mockState
  return { useAppStore }
})

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => mocks.bucketCounts
}))

vi.mock('./SidebarWorkspaceOptionsMenu', () => ({
  default: () => <button aria-label="Workspace options" type="button" />
}))

vi.mock('./workspace-options-menu-items', () => ({
  useWorkspaceOptionsFilterBadge: () => ({
    hasAnyFilter: false,
    activeFilterCount: 0
  }),
  WorkspaceOptionsMenuItems: () => null
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘N',
  formatOptionalPrimaryShortcutLabel: () => mocks.shortcutLabel.current
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('../contextual-tours/workspace-creation-tour-handoff', () => ({
  openWorkspaceCreationComposerWithTourHandoff: mocks.openWorkspaceCreationComposerWithTourHandoff
}))

vi.mock('sonner', () => ({ toast: Object.assign(mocks.toast, { error: mocks.toastError }) }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))

vi.mock('@/lib/worktree-creation-flow', () => ({
  runBackgroundWorktreeCreation: mocks.runBackgroundWorktreeCreation
}))

// Expose open state directly to isolate this header test from Radix portals.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-intro-open={open ? '' : undefined}>{children}</div>
  ),
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverArrow: () => <div data-testid="popover-arrow" />,
  PopoverContent: ({ children, ...props }: { children: React.ReactNode }) => {
    mocks.popoverContentProps.current = props
    return <>{children}</>
  }
}))

let container: HTMLDivElement
let root: Root

function headerButton(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (!button) {
    throw new Error(`Header button not rendered: ${label}`)
  }
  return button
}

function createButton(): HTMLButtonElement {
  return headerButton('New workspace')
}

beforeEach(() => {
  mocks.bucketCounts = { attention: 0, working: 0, done: 0, idle: 0 }
  mocks.openWorkspaceCreationComposerWithTourHandoff.mockClear()
  mocks.toast.mockClear()
  mocks.toastError.mockReset()
  mocks.createFolderWorkspace.mockReset().mockResolvedValue(makeFolderWorkspace())
  mocks.activateAndRevealFolderWorkspace.mockReset()
  mocks.runBackgroundWorktreeCreation.mockReset()
  mocks.shortcutLabel.current = '⌘N'
  mockState = {
    repos: [],
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null,
    activeRepoId: null,
    folderWorkspaces: [],
    projectGroups: [],
    createFolderWorkspace: mocks.createFolderWorkspace,
    runtimeStatusByEnvironmentId: new Map<string, never>(),
    groupBy: 'repo',
    sidebarBody: 'workspaces',
    sidebarWidth: 280,
    setSidebarBody: vi.fn(),
    openModal: vi.fn(),
    closeModal: vi.fn(),
    activeModal: 'none',
    worktreesByRepo: {},
    updateSettings: vi.fn(),
    activeContextualTourId: null,
    settings: {}
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarHeader', () => {
  it.each(['workspaces', 'agents'] as const)(
    'prioritizes questions, then working, and shows idle zero in the %s view',
    (sidebarBody) => {
      mockState.sidebarBody = sidebarBody
      const render = () => {
        act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))
        return headerButton(sidebarBody === 'agents' ? 'Turn off activity view' : 'View activity')
      }
      mocks.bucketCounts = { attention: 2, working: 5, done: 3, idle: 4 }
      let button = render()
      expect(button.querySelector('[aria-label="Needs You: 2"]')?.textContent).toBe('2')
      expect(button.querySelector('.lucide-message-circle-question-mark')).toBeTruthy()
      expect(button.querySelector('[aria-label="Working: 5"]')).toBeNull()

      mocks.bucketCounts.attention = 0
      button = render()
      expect(button.querySelector('[aria-label="Working: 5"]')?.textContent).toBe('5')
      expect(button.querySelector('.lucide-message-circle-question-mark')).toBeNull()

      mocks.bucketCounts.working = 0
      button = render()
      expect(button.querySelector('[aria-label="Idle: 0"]')?.textContent).toBe('0')
      expect(button.querySelector('.lucide-message-circle-question-mark')).toBeNull()
      expect(button.getAttribute('aria-describedby')).toBe(
        button.querySelector('[aria-label="Idle: 0"]')?.id
      )
    }
  )

  it.each([9, 12, 99, 100])('keeps the working count accessible at %s agents', (working) => {
    mocks.bucketCounts.working = working
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))
    const button = headerButton('View activity')
    const status = button.querySelector(`[aria-label="Working: ${working}"]`)
    expect(status?.textContent).toBe(working > 99 ? '99+' : String(working))
    expect(button.getAttribute('aria-describedby')).toBe(status?.id)
  })

  it('keeps New workspace clickable with zero projects, since the composer adds the first one', async () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(createButton().disabled).toBe(false)

    await act(async () => {
      createButton().click()
    })

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('reaches Add project and New workspace in one click each, with no menu', async () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(headerButton('New workspace')).toBeTruthy()
    expect(headerButton('Add project')).toBeTruthy()
    expect(container.querySelector('[data-slot="dropdown-menu-trigger"]')).toBeNull()

    await act(async () => {
      headerButton('Add project').click()
    })

    expect(mockState.openModal).toHaveBeenCalledWith('add-repo')
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).not.toHaveBeenCalled()
  })

  it('keeps the composer path for the current git worktree', async () => {
    mockState.activeWorkspaceKey = 'worktree:current-worktree'
    mockState.activeWorktreeId = 'current-worktree'
    mockState.activeRepoId = 'current-repo'
    mockState.repos = [{ id: 'other-repo' }, { id: 'current-repo' }]
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))

    await act(async () => createButton().click())

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
    expect(mocks.createFolderWorkspace).not.toHaveBeenCalled()
  })

  it('seeds the composer from the current git worktree when another repo is selected', async () => {
    mockState.activeWorkspaceKey = 'worktree:current-worktree'
    mockState.activeWorktreeId = 'current-worktree'
    mockState.activeRepoId = 'other-repo'
    mockState.repos = [
      { id: 'other-repo', kind: 'git' },
      { id: 'current-repo', kind: 'git' }
    ]
    mockState.worktreesByRepo = {
      'current-repo': [{ id: 'current-worktree', repoId: 'current-repo', path: '/tmp/current' }]
    }
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))

    await act(async () => createButton().click())

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledWith({
      initialRepoId: 'current-repo'
    })
  })

  it('creates in the inferred SSH folder when the project group has no host pin', async () => {
    mockState.projectGroups = [makeProjectGroup()]
    mockState.folderWorkspaces = [makeFolderWorkspace()]
    mockState.repos = [
      {
        id: 'repo-1',
        projectGroupId: 'group-1',
        path: '/repo/platform/app',
        connectionId: 'box'
      }
    ]
    mockState.activeWorkspaceKey = 'folder:folder-workspace-1'
    mockState.activeWorkspaceExecutionHostId = 'ssh:box'
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))

    await act(async () => createButton().click())

    expect(mocks.createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectGroupId: 'group-1',
        folderPath: '/repo/platform/hi',
        connectionId: 'box'
      }),
      { runtimeEnvironmentId: null }
    )
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).not.toHaveBeenCalled()
  })

  it('closes an open Add project dialog before creating the current folder', async () => {
    mockState.projectGroups = [makeProjectGroup()]
    mockState.folderWorkspaces = [makeFolderWorkspace()]
    mockState.activeWorkspaceKey = 'folder:folder-workspace-1'
    mockState.activeModal = 'add-repo'
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))

    await act(async () => createButton().click())

    expect(mockState.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.createFolderWorkspace).toHaveBeenCalled()
  })

  it('creates an Open as Folder workspace without the composer', async () => {
    mockState.activeWorkspaceKey = 'worktree:notes::/tmp/notes'
    mockState.activeWorktreeId = 'notes::/tmp/notes'
    mockState.activeRepoId = 'other-repo'
    mockState.repos = [
      { id: 'other-repo', kind: 'git' },
      { id: 'notes', kind: 'folder', path: '/tmp/notes' }
    ]
    mockState.worktreesByRepo = {
      notes: [{ id: 'notes::/tmp/notes', repoId: 'notes', path: '/tmp/notes' }]
    }
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))

    await act(async () => createButton().click())

    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'notes',
        setupDecision: 'skip',
        agent: null,
        telemetrySource: 'sidebar'
      })
    )
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).not.toHaveBeenCalled()
  })

  it('creates and reveals a default folder workspace in the current folder project', async () => {
    mockState.projectGroups = [{ ...makeProjectGroup(), executionHostId: 'runtime:folder-host' }]
    mockState.folderWorkspaces = [makeFolderWorkspace({ executionHostId: 'runtime:folder-host' })]
    mockState.activeWorkspaceKey = 'folder:folder-workspace-1'
    mockState.activeWorkspaceExecutionHostId = 'runtime:folder-host'
    mockState.activeWorktreeId = 'previous-git-worktree'
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))

    await act(async () => createButton().click())

    expect(mocks.createFolderWorkspace).toHaveBeenCalledWith(
      {
        projectGroupId: 'group-1',
        name: 'Platform workspace',
        folderPath: '/repo/platform/hi',
        connectionId: null,
        linkedTask: null
      },
      { runtimeEnvironmentId: 'folder-host' }
    )
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      agent: null,
      runtimeEnvironmentId: 'folder-host'
    })
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).not.toHaveBeenCalled()
    expect(mockState.openModal).not.toHaveBeenCalled()
  })

  it('shows the existing error toast when direct folder creation fails', async () => {
    mockState.projectGroups = [makeProjectGroup()]
    mockState.folderWorkspaces = [makeFolderWorkspace()]
    mockState.activeWorkspaceKey = 'folder:folder-workspace-1'
    mocks.createFolderWorkspace.mockRejectedValue(new Error('Folder is unavailable. Try again.'))
    act(() => root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />))

    await act(async () => createButton().click())

    expect(mocks.toastError).toHaveBeenCalledWith('Folder is unavailable. Try again.')
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).not.toHaveBeenCalled()
  })
})
