// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NewExternalWorktreesInboxLine from './NewExternalWorktreesInboxLine'
import type { NewExternalWorktreeInboxPreview } from './new-external-worktrees-inbox-candidates'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  )
}))

const roots: Root[] = []
const onManageVisibility = vi.fn()

function makePreview(index: number): NewExternalWorktreeInboxPreview {
  return {
    id: `external-${index}`,
    displayName: `payments-refactor-${index}`,
    branch: `refs/heads/payments-refactor-${index}`,
    path: `/repo/.claude/worktrees/payments-refactor-${index}`,
    displayPath: `.claude/worktrees/payments-refactor-${index}`
  }
}

async function renderLine(
  inboxWorktrees: NewExternalWorktreeInboxPreview[] = [makePreview(1)]
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <NewExternalWorktreesInboxLine
        repoDisplayName="orca"
        inboxWorktrees={inboxWorktrees}
        pending={false}
        error={null}
        onImportWorktree={vi.fn()}
        onKeepHidden={vi.fn()}
        onImportAll={vi.fn()}
        onSuppress={vi.fn()}
        onManageVisibility={onManageVisibility}
      />
    )
  })

  return container
}

async function expand(container: HTMLDivElement): Promise<void> {
  const expandButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Expand new externally-created worktrees for orca"]'
  )
  await act(async () => {
    expandButton?.click()
  })
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

    await expand(container)

    expect(container.textContent).toContain('payments-refactor')
    const textButtons = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === "Don't show again"
    )
    expect(textButtons).toHaveLength(0)
  })

  it('speaks the same show vocabulary as the visibility dialog, with a quiet bulk action', async () => {
    const container = await renderLine()
    await expand(container)

    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toContain('Show')
    expect(labels).toContain('Show all')
    expect(labels).not.toContain('Import')
    expect(labels).not.toContain('Import all')
    const bulkButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show all'
    )
    // Why: a filled button here would be the only one in the sidebar; siblings use outline.
    expect(bulkButton?.className).not.toContain('bg-primary')
  })

  it('reveals the project actions entry from the recovery pointer', async () => {
    const container = await renderLine()
    await expand(container)

    expect(container.textContent).toContain('You can always change this later from here')
    const manageButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'here'
    )
    // Why: only the link word carries the underline, the sentence around it stays plain.
    expect(manageButton?.className).toContain('underline')
    await act(async () => {
      manageButton?.click()
    })

    expect(onManageVisibility).toHaveBeenCalled()
  })

  it('shows repo-relative paths instead of the absolute checkout path', async () => {
    const container = await renderLine()
    await expand(container)

    expect(container.textContent).toContain('.claude/worktrees/payments-refactor-1')
    expect(container.textContent).not.toContain('/repo/.claude/worktrees/payments-refactor-1')
  })

  it('caps the preview so a scratch burst cannot wall off the sidebar', async () => {
    const container = await renderLine([1, 2, 3, 4, 5].map(makePreview))
    await expand(container)

    expect(container.textContent).toContain('payments-refactor-3')
    expect(container.textContent).not.toContain('payments-refactor-4')

    const moreButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Show 2 more')
    )
    await act(async () => {
      moreButton?.click()
    })

    expect(container.textContent).toContain('payments-refactor-5')
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toContain(
      'Show fewer'
    )
  })
})
