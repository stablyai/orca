// @vitest-environment happy-dom
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission, MissionDeleteResult } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  deleteMission:
    vi.fn<(missionId: string, deleteWorktrees: boolean) => Promise<MissionDeleteResult | null>>(),
  repos: [] as { id: string; displayName: string }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ deleteMission: mocks.deleteMission, repos: mocks.repos })
}))

// Why: the real Radix dialog portals into document.body behind presence
// animations; a shallow mock keeps the component under test mounted across
// open/close exactly like production, which is what these tests exercise.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

import { MissionDeleteDialog } from './MissionDeleteDialog'

function makeMission(id: string, name: string): Mission {
  return {
    id,
    name,
    branchName: `mission/${name.toLowerCase()}`,
    members: [],
    tabOrder: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderDialog(mission: Mission | null): HTMLDivElement {
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => {
    root?.render(<MissionDeleteDialog mission={mission} onOpenChange={() => {}} />)
  })
  return container!
}

function getDeleteButton(scope: HTMLElement): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === 'Delete'
  )
  if (!button) {
    throw new Error('Delete button not found')
  }
  return button
}

const FAILURE_COPY = 'Some workspaces could not be deleted.'

describe('MissionDeleteDialog', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.deleteMission.mockReset()
    mocks.repos = []
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('shows the failure banner when a delete leaves members behind', async () => {
    mocks.deleteMission.mockResolvedValue({
      deleted: false,
      memberResults: [{ repoId: 'r1', worktreeId: 'wt-1', error: 'uncommitted changes' }]
    })
    const rendered = renderDialog(makeMission('m1', 'Referral'))

    await act(async () => {
      getDeleteButton(rendered).click()
    })

    expect(mocks.deleteMission).toHaveBeenCalledWith('m1', true)
    expect(rendered.textContent).toContain(FAILURE_COPY)
  })

  it('reseeds the failure banner and worktree checkbox on the next open', async () => {
    mocks.deleteMission.mockResolvedValue({ deleted: false, memberResults: [] })
    let rendered = renderDialog(makeMission('m1', 'Referral'))

    // Fail a delete and flip the checkbox so both pieces of state are dirty.
    await act(async () => {
      getDeleteButton(rendered).click()
    })
    const checkbox = rendered.querySelector<HTMLButtonElement>('#mission-delete-worktrees')
    expect(checkbox).not.toBeNull()
    await act(async () => {
      checkbox?.click()
    })
    expect(rendered.textContent).toContain(FAILURE_COPY)
    expect(checkbox?.getAttribute('aria-checked')).toBe('false')

    // Close (the dialog component stays mounted) and reopen with another mission.
    renderDialog(null)
    rendered = renderDialog(makeMission('m2', 'Demo'))

    expect(rendered.textContent).not.toContain(FAILURE_COPY)
    expect(
      rendered
        .querySelector<HTMLButtonElement>('#mission-delete-worktrees')
        ?.getAttribute('aria-checked')
    ).toBe('true')
  })
})
