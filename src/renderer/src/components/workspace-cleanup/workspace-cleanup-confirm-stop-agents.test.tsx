// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'
import { WorkspaceCleanupConfirmStopAgents } from './workspace-cleanup-confirm-stop-agents'
import { getWorkspaceCleanupCandidateAccessibleName } from './workspace-cleanup-host-label'

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

describe('WorkspaceCleanupConfirmStopAgents', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  it('names each workspace whose agent will be stopped and wires both buttons', () => {
    const candidates = [
      makeFacetCandidate({ worktreeId: 'repo-1::/b', displayName: 'b' }),
      makeFacetCandidate({ worktreeId: 'repo-1::/c', displayName: 'c' })
    ]
    const onBack = vi.fn()
    const onConfirm = vi.fn()
    act(() =>
      root.render(
        <WorkspaceCleanupConfirmStopAgents
          candidates={candidates}
          onBack={onBack}
          onConfirm={onConfirm}
        />
      )
    )

    expect(container.textContent).toContain('Stop these agents?')
    expect(container.textContent).toContain("Deleting will stop these agents' current work.")
    for (const candidate of candidates) {
      expect(
        container.querySelector(
          `[aria-label="${getWorkspaceCleanupCandidateAccessibleName(candidate)}"]`
        )
      ).not.toBeNull()
    }
    const buttons = [...container.querySelectorAll('button')]
    act(() => buttons.find((button) => button.textContent === 'Back')?.click())
    act(() => buttons.find((button) => button.textContent === 'Stop agents and delete')?.click())
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('reuses the close-terminal wording for a single agent', () => {
    act(() =>
      root.render(
        <WorkspaceCleanupConfirmStopAgents
          candidates={[makeFacetCandidate({ worktreeId: 'repo-1::/b', displayName: 'b' })]}
          onBack={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    )

    expect(container.textContent).toContain('Stop this agent?')
    expect(container.textContent).toContain("Deleting will stop the agent's current work.")
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toContain(
      'Stop agent and delete'
    )
  })
})
