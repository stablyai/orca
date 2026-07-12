// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type { Mission } from '../../../../shared/types'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/store-test-helpers'
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
      ...state
    })
  })
}

describe('MissionList', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
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

  it('renders the session card when the mission session workspace exists', () => {
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
    seedMissionListState({
      missions: [mission],
      folderWorkspaces: [
        {
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
      ]
    })
    const container = renderMissionList()
    // The mission row IS the session card.
    expect(container.querySelector('[data-mission-id]')).toBeTruthy()
    expect(
      container.querySelector('[data-worktree-card-meta-row], [class*="rounded"]')
    ).toBeTruthy()
    expect(container.textContent).toContain('Referral')
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
    expect(container.textContent).toContain('1 projects')
    expect(container.textContent).toContain(TEST_REPO.displayName)
    expect(container.textContent).toContain('Workspace missing')
  })
})
