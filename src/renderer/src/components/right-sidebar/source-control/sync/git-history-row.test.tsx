// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHistoryItemRef } from '../../../../../../shared/git/history/git-history-types'
import type { GitHistoryItemViewModel } from '../../../../../../shared/git/history/git-history-graph'
import { GitHistoryRow } from './git-history-row'

// Radix tooltips never open from synthetic pointer events under happy-dom, so render
// their content inline and assert what the row passes to the primitive instead.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="tooltip-content">{children}</div>
  )
}))

const subject = 'Fix retained agent exits'
const message = `${subject}\n\nRetire exits only after their owning session ends.`

function viewModel(commitMessage = message): GitHistoryItemViewModel {
  return {
    historyItem: { id: 'abc123', parentIds: [], subject, message: commitMessage },
    kind: 'node',
    inputSwimlanes: [],
    outputSwimlanes: []
  }
}

function tooltipTexts(): string[] {
  return [...document.querySelectorAll('[data-slot="tooltip-content"]')].map(
    (element) => element.textContent ?? ''
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Git history commit details', () => {
  it('shows the full commit message for the subject', () => {
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel()} />
      </TooltipProvider>
    )

    expect(tooltipTexts()).toContain(message)
  })

  it('falls back to the subject when a commit has no message', () => {
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel('')} />
      </TooltipProvider>
    )

    expect(tooltipTexts()).toContain(subject)
  })

  it.each([
    {
      label: 'branch',
      references: [
        { id: 'refs/heads/feature', name: 'feature', category: 'branches' }
      ] satisfies GitHistoryItemRef[],
      trigger: 'feature',
      content: 'feature (branches)'
    },
    {
      label: 'hidden refs',
      references: [
        { id: 'refs/heads/feature', name: 'feature', category: 'branches' },
        { id: 'refs/remotes/origin/main', name: 'origin/main', category: 'remote branches' },
        { id: 'refs/tags/v1', name: 'v1', category: 'tags' }
      ] satisfies GitHistoryItemRef[],
      trigger: '+1',
      content: 'v1'
    }
  ])('shows the $label tooltip', (testCase) => {
    const model = viewModel()
    model.historyItem.references = testCase.references
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={model} />
      </TooltipProvider>
    )

    expect(screen.getByText(testCase.trigger)).not.toBeNull()
    expect(tooltipTexts()).toContain(testCase.content)
  })

  it('still expands files instead of opening the combined diff on a row click', () => {
    const onToggleExpand = vi.fn()
    const onOpenCommit = vi.fn()
    const model = viewModel()
    render(
      <TooltipProvider>
        <GitHistoryRow
          viewModel={model}
          onToggleExpand={onToggleExpand}
          onOpenCommit={onOpenCommit}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button'))

    expect(onToggleExpand).toHaveBeenCalledExactlyOnceWith(model.historyItem)
    expect(onOpenCommit).not.toHaveBeenCalled()
  })
})
