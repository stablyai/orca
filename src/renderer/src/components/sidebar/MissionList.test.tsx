// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type { Mission } from '../../../../shared/types'

const activateWorktreeFromSidebar = vi.hoisted(() => vi.fn())
const confirmMissionMemberRemoval = vi.hoisted(() => vi.fn().mockResolvedValue(true))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

vi.mock('@/lib/sidebar-worktree-activation', () => ({ activateWorktreeFromSidebar }))
vi.mock('@/components/confirmation-dialog', () => ({
  useConfirmationDialog: () => confirmMissionMemberRemoval
}))

import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { TooltipProvider } from '@/components/ui/tooltip'
import MissionList from './MissionList'

const missionRootPath = path.join(path.sep, 'tmp', 'orca', 'missions', 'referral')

let root: Root | null = null

function renderMissionList(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        <MissionList />
      </TooltipProvider>
    )
  })
  return container
}

function seedMissionListState(state: object): void {
  act(() => {
    ;(useAppStore as unknown as { setState: (s: object) => void }).setState({
      repos: [TEST_REPO],
      missions: [],
      folderWorkspaces: [],
      worktreesByRepo: {},
      missionMemberErrors: {},
      ...state
    })
  })
}

describe('MissionList', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activateWorktreeFromSidebar.mockReset()
    confirmMissionMemberRemoval.mockReset()
    confirmMissionMemberRemoval.mockResolvedValue(true)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('shows the empty state without missions', () => {
    seedMissionListState({
      missions: []
    })
    const container = renderMissionList()
    expect(container.textContent).toContain('No missions yet')
    expect(container.textContent).toContain('New Mission')
  })

  it('renders a retry fallback row while the mission session materializes', () => {
    const mission: Mission = {
      id: 'm1',
      name: 'Referral',
      branchName: 'mission/referral',
      members: [],
      tabOrder: 0,
      createdAt: 1,
      updatedAt: 1
    }
    seedMissionListState({
      missions: [mission],
      folderWorkspaces: []
    })
    const container = renderMissionList()
    // The row itself is the (re)ensure affordance; no separate open action.
    expect(container.textContent).toContain('Referral')
    expect(container.textContent).toContain('0 projects')
    expect(container.textContent).not.toContain('Open mission session')
  })

  it('re-ensures a persisted session before activating its workspace', async () => {
    const mission: Mission = {
      id: 'm1',
      name: 'Referral',
      branchName: 'mission/referral',
      members: [],
      tabOrder: 0,
      rootPath: missionRootPath,
      createdAt: 1,
      updatedAt: 1
    }
    const sessionWorkspace = {
      id: 'fw-1',
      projectGroupId: 'mission:m1',
      missionId: 'm1',
      name: 'Referral',
      folderPath: missionRootPath,
      connectionId: null,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const ensureMissionSession = vi.fn().mockResolvedValue(sessionWorkspace)
    const setActiveWorktree = vi.fn()
    seedMissionListState({
      missions: [mission],
      folderWorkspaces: [sessionWorkspace],
      ensureMissionSession,
      setActiveWorktree
    })
    const container = renderMissionList()
    // The mission row IS the session card.
    expect(container.querySelector('[data-mission-id]')).toBeTruthy()
    expect(
      container.querySelector('[data-worktree-card-meta-row], [class*="rounded"]')
    ).toBeTruthy()
    expect(container.textContent).toContain('Referral')

    await act(async () => {
      container.querySelector<HTMLElement>('[data-worktree-card-surface="true"]')?.click()
    })
    expect(ensureMissionSession).toHaveBeenCalledWith('m1')
    expect(setActiveWorktree).toHaveBeenCalledWith('folder:fw-1')
    expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
  })

  it('renders a mission header with member count and a recreate row for missing worktrees', () => {
    const mission: Mission = {
      id: 'm1',
      name: 'Referral',
      branchName: 'mission/referral',
      members: [{ repoId: TEST_REPO.id, worktreeId: null, addedAt: 1 }],
      tabOrder: 0,
      createdAt: 1,
      updatedAt: 1
    }
    seedMissionListState({
      missions: [mission]
    })
    const container = renderMissionList()
    expect(container.textContent).toContain('Referral')
    expect(container.textContent).toContain('1 project')
    expect(container.textContent).not.toContain('1 projects')
    expect(container.textContent).toContain(TEST_REPO.displayName)
    expect(container.textContent).toContain('Workspace missing')
  })

  it('confirms before removing a live member and its in-root checkout', async () => {
    const worktree = makeWorktree({
      id: `${TEST_REPO.id}::/tmp/referral`,
      repoId: TEST_REPO.id,
      instanceId: 'instance-1',
      branch: 'refs/heads/mission/referral'
    })
    const removeMissionMember = vi.fn()
    const mission: Mission = {
      id: 'm1',
      name: 'Referral',
      branchName: 'mission/referral',
      members: [
        {
          repoId: TEST_REPO.id,
          worktreeId: worktree.id,
          worktreeInstanceId: 'instance-1',
          lastError: 'Durable worktree warning',
          addedAt: 1
        }
      ],
      tabOrder: 0,
      createdAt: 1,
      updatedAt: 1
    }
    seedMissionListState({
      missions: [mission],
      worktreesByRepo: { [TEST_REPO.id]: [worktree] },
      removeMissionMember
    })
    const container = renderMissionList()

    expect(container.textContent).toContain('Durable worktree warning')
    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove from mission"]'
    )
    expect(removeButton).not.toBeNull()
    await act(async () => removeButton?.click())
    expect(confirmMissionMemberRemoval).toHaveBeenCalledWith(
      expect.objectContaining({ confirmVariant: 'destructive' })
    )
    expect(removeMissionMember).toHaveBeenCalledWith('m1', TEST_REPO.id, true)
  })

  it('does not expose a same-path replacement as a live Mission member', () => {
    const replacement = makeWorktree({
      id: `${TEST_REPO.id}::/tmp/referral`,
      repoId: TEST_REPO.id,
      instanceId: 'replacement-instance',
      branch: 'refs/heads/mission/referral'
    })
    const mission: Mission = {
      id: 'm1',
      name: 'Referral',
      branchName: 'mission/referral',
      members: [
        {
          repoId: TEST_REPO.id,
          worktreeId: replacement.id,
          worktreeInstanceId: 'original-instance',
          addedAt: 1
        }
      ],
      tabOrder: 0,
      createdAt: 1,
      updatedAt: 1
    }
    seedMissionListState({
      missions: [mission],
      worktreesByRepo: { [TEST_REPO.id]: [replacement] }
    })

    const container = renderMissionList()

    expect(container.textContent).toContain('Workspace missing')
    expect(container.querySelector('button[aria-label="Recreate"]')).not.toBeNull()
  })
})
