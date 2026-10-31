// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceCleanupCandidateIdentity } from './workspace-cleanup-host-identity'
import { CandidateRow } from './workspace-cleanup-candidate-row'
import { getWorkspaceCleanupCandidateAccessibleName } from './workspace-cleanup-host-label'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

describe('CandidateRow', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('hides selection and remove controls while the workspace is already deleting', () => {
    const candidate = makeCandidate()

    act(() => {
      root?.render(
        <CandidateRow
          identity={getWorkspaceCleanupCandidateIdentity(candidate)}
          candidate={candidate}
          expanded={false}
          last
          lastActivityLabel="1d ago"
          removing
          reviewInfo={{
            hasReview: false,
            label: null,
            provider: null,
            state: null,
            title: null
          }}
          selected
          onIgnore={vi.fn()}
          onRemove={vi.fn()}
          onToggleExpanded={vi.fn()}
          onToggleSelected={vi.fn()}
          onView={vi.fn()}
        />
      )
    })

    const accessibleName = getWorkspaceCleanupCandidateAccessibleName(candidate)
    expect(container?.querySelector(`[aria-label="Select ${accessibleName}"]`)).toBeNull()
    expect(container?.querySelector(`[aria-label="Remove ${accessibleName}"]`)).toBeNull()
  })

  it('visibly and accessibly distinguishes colliding local and SSH rows', () => {
    const local = makeCandidate({ executionHostId: 'local' })
    const remote = makeCandidate({ connectionId: 'builder', executionHostId: 'ssh:builder' })

    act(() => {
      root?.render(
        <>
          {[local, remote].map((candidate) => (
            <CandidateRow
              key={candidate.executionHostId}
              identity={getWorkspaceCleanupCandidateIdentity(candidate)}
              candidate={candidate}
              expanded={false}
              last={false}
              lastActivityLabel="1d ago"
              reviewInfo={{
                hasReview: false,
                label: null,
                provider: null,
                state: null,
                title: null
              }}
              selected={false}
              onIgnore={vi.fn()}
              onRemove={vi.fn()}
              onToggleExpanded={vi.fn()}
              onToggleSelected={vi.fn()}
              onView={vi.fn()}
            />
          ))}
        </>
      )
    })

    const localName = getWorkspaceCleanupCandidateAccessibleName(local)
    const remoteName = getWorkspaceCleanupCandidateAccessibleName(remote)
    expect(localName).not.toBe(remoteName)
    expect(container?.querySelector(`[aria-label="Select ${localName}"]`)).not.toBeNull()
    expect(container?.querySelector(`[aria-label="Select ${remoteName}"]`)).not.toBeNull()
    expect(container?.querySelector(`[aria-label="Host: builder"]`)).not.toBeNull()
  })
})
