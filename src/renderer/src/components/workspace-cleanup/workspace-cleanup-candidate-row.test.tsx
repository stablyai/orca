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

  it('does not present cleanup policy tiers as workspace facts', () => {
    const candidate = makeCandidate({ tier: 'ready' })

    act(() => {
      root?.render(
        <CandidateRow
          identity={getWorkspaceCleanupCandidateIdentity(candidate)}
          candidate={candidate}
          expanded={false}
          last
          lastActivityLabel="1d ago"
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

    expect(container?.textContent).not.toContain('Ready')
    expect(container?.textContent).not.toContain('Status unavailable')
  })

  it('shows factual status, disk size, activity, and git state before expansion', () => {
    const candidate = makeCandidate({ tier: 'ready' })

    act(() => {
      root?.render(
        <CandidateRow
          identity={getWorkspaceCleanupCandidateIdentity(candidate)}
          candidate={candidate}
          expanded={false}
          last
          lastActivityLabel="1d ago"
          sizeLabel="4.00 MB"
          workspaceStatusLabel="In progress"
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

    expect(container?.textContent).toContain('In progress')
    expect(container?.textContent).toContain('4.00 MB')
    expect(container?.textContent).toContain('1d')
    expect(container?.textContent).toContain('Clean')
  })

  it('uses an external-link action to open the workspace', () => {
    const candidate = makeCandidate()

    act(() => {
      root?.render(
        <CandidateRow
          identity={getWorkspaceCleanupCandidateIdentity(candidate)}
          candidate={candidate}
          expanded={false}
          last
          lastActivityLabel="1d ago"
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

    const openButton = container?.querySelector(
      `[aria-label="Open ${getWorkspaceCleanupCandidateAccessibleName(candidate)}"]`
    )
    expect(openButton?.querySelector('.lucide-external-link')).not.toBeNull()
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

  it.each([
    ['deleting' as const, 'Deleting…'],
    ['queued' as const, 'Queued for deletion']
  ])('replaces the status pill with the %s state', (deletionPhase, label) => {
    const candidate = makeCandidate()

    act(() => {
      root?.render(
        <CandidateRow
          identity={getWorkspaceCleanupCandidateIdentity(candidate)}
          candidate={candidate}
          deletionPhase={deletionPhase}
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

    expect(container?.textContent).toContain(label)
    expect(container?.textContent).not.toContain('Ready')
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
