// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'
import { WorkspaceCleanupConfirmRemove } from './workspace-cleanup-confirm-remove'
import {
  getWorkspaceCleanupCandidateAccessibleName,
  getWorkspaceCleanupCandidateHostLabel
} from './workspace-cleanup-host-label'

const listProbe = vi.hoisted(() => vi.fn())

vi.mock('./workspace-cleanup-candidate-list', () => ({
  WorkspaceCleanupCandidateList: <Row,>({
    rows,
    renderRow
  }: {
    rows: readonly Row[]
    renderRow: (row: Row, index: number) => ReactNode
  }) => {
    listProbe(rows.length)
    return <>{rows.slice(0, 5).map(renderRow)}</>
  }
}))

vi.mock('@/components/ui/dialog', () => ({
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

describe('WorkspaceCleanupConfirmRemove', () => {
  beforeEach(() => {
    listProbe.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  it('routes fleet-sized confirmations through the bounded row list', () => {
    const candidates = Array.from({ length: 2_727 }, (_, index) =>
      makeFacetCandidate({
        worktreeId: `repo-1::/repo/worktree-${index}`,
        displayName: `Workspace ${index}`,
        path: `/repo/worktree-${index}`
      })
    )

    act(() => {
      root.render(
        <WorkspaceCleanupConfirmRemove
          candidates={candidates}
          now={Date.now()}
          reviewInfoByWorktreeId={new Map()}
          progress={null}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    })

    expect(listProbe).toHaveBeenCalledWith(candidates.length)
    expect(container.querySelectorAll('span.truncate.text-sm.font-medium')).toHaveLength(5)
  })

  it('visibly and accessibly identifies each host for colliding confirmations', () => {
    const local = makeFacetCandidate({ executionHostId: 'local' })
    const remote = makeFacetCandidate({
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    })

    act(() => {
      root.render(
        <WorkspaceCleanupConfirmRemove
          candidates={[local, remote]}
          now={Date.now()}
          reviewInfoByWorktreeId={new Map()}
          progress={null}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    })

    expect(getWorkspaceCleanupCandidateAccessibleName(local)).not.toBe(
      getWorkspaceCleanupCandidateAccessibleName(remote)
    )
    for (const candidate of [local, remote]) {
      const name = getWorkspaceCleanupCandidateAccessibleName(candidate)
      const hostLabel = getWorkspaceCleanupCandidateHostLabel(candidate)
      expect(container.querySelector(`[role="group"][aria-label="${name}"]`)).not.toBeNull()
      expect(container.querySelector(`[aria-label="Host: ${hostLabel}"]`)).not.toBeNull()
    }
  })
})
