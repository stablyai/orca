// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NewExternalWorktreesInboxLine from './NewExternalWorktreesInboxLine'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  )
}))

const roots: Root[] = []

async function renderLine(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <NewExternalWorktreesInboxLine
        repoDisplayName="orca"
        inboxWorktrees={[
          {
            id: 'external-1',
            displayName: 'payments-refactor',
            branch: 'refs/heads/payments-refactor',
            path: '/worktrees/orca/payments-refactor'
          }
        ]}
        pending={false}
        error={null}
        onImportWorktree={vi.fn()}
        onKeepHidden={vi.fn()}
        onImportAll={vi.fn()}
        onSuppress={vi.fn()}
      />
    )
  })

  return container
}

describe('NewExternalWorktreesInboxLine', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('keeps suppress as a hover-revealed header icon instead of expanded text action', async () => {
    const container = await renderLine()

    const suppressButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide external worktrees permanently for orca"]'
    )
    expect(suppressButton).not.toBeNull()
    expect(suppressButton?.className).toContain('can-hover:group-hover:opacity-100')
    expect(container.textContent).toContain("Don't show again")

    const expandButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand new externally-created worktrees for orca"]'
    )
    await act(async () => {
      expandButton?.click()
    })

    expect(container.textContent).toContain('payments-refactor')
    const textButtons = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === "Don't show again"
    )
    expect(textButtons).toHaveLength(0)
  })
})
