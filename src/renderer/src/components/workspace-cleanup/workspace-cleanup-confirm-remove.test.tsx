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

  it('names each local context type separately instead of totalling them', () => {
    const candidate = makeFacetCandidate({
      worktreeId: 'repo-1::/repo/with-context',
      displayName: 'Has context',
      localContext: {
        terminalTabCount: 1,
        cleanEditorTabCount: 2,
        browserTabCount: 3,
        diffCommentCount: 4,
        newestDiffCommentAt: null,
        retainedDoneAgentCount: 5
      }
    })

    act(() => {
      root.render(
        <WorkspaceCleanupConfirmRemove
          candidates={[candidate]}
          now={Date.now()}
          reviewInfoByWorktreeId={new Map()}
          progress={null}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    })

    const labels = [
      'Terminal tabs: 1',
      'Editor tabs: 2',
      'Browser tabs: 3',
      'Diff notes: 4',
      'Completed agents: 5'
    ]
    const renderedLabels = Array.from(container.querySelectorAll('span'))
      .map((element) => element.textContent)
      .filter((label): label is string => labels.includes(label ?? ''))

    expect(renderedLabels).toEqual(labels)
    expect(container.textContent).not.toContain('Context: ')
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

  it('shows every destructive git risk and the fleet-level force projection', () => {
    const failed = makeFacetCandidate({
      worktreeId: 'repo-1::/failed',
      blockers: ['pinned', 'git-status-error'],
      git: {
        clean: null,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: null
      }
    })
    const unknownBase = makeFacetCandidate({
      worktreeId: 'repo-1::/unknown-base',
      blockers: ['unknown-base']
    })

    act(() => {
      root.render(
        <WorkspaceCleanupConfirmRemove
          candidates={[failed, unknownBase]}
          now={Date.now()}
          reviewInfoByWorktreeId={new Map()}
          progress={null}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Pinned')
    expect(container.textContent).toContain('Git status unavailable')
    expect(container.textContent).toContain('Could not verify unpushed commits')
    expect(container.textContent).toContain(
      '2 workspaces currently show risk and may need a force delete'
    )
    expect(
      [...container.querySelectorAll('.text-destructive')].map((node) => node.textContent)
    ).toEqual(
      expect.arrayContaining(['Git status unavailable', 'Could not verify unpushed commits'])
    )

    act(() => {
      root.render(
        <WorkspaceCleanupConfirmRemove
          candidates={[failed]}
          now={Date.now()}
          reviewInfoByWorktreeId={new Map()}
          progress={null}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    })
    expect(container.textContent).toContain(
      '1 workspace currently shows risk and may need a force delete'
    )
  })
})
