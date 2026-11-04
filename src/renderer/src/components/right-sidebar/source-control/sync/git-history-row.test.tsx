// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHistoryItemRef } from '../../../../../../shared/git-history'
import type { GitHistoryItemViewModel } from '../../../../../../shared/git-history-graph'
import { GitHistoryRow } from './git-history-row'

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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Git history commit details', () => {
  it('opens only after hovering for 400ms and closes shortly after leaving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel()} />
      </TooltipProvider>
    )
    const trigger = screen.getByText(subject)
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(399))
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(document.querySelector('[data-slot="hover-card-content"]')?.textContent).toBe(message)

    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
  })

  it('cancels the preview when the pointer quickly passes over a commit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel()} />
      </TooltipProvider>
    )
    const trigger = screen.getByText(subject)
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(150))
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(399))
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(document.querySelector('[data-slot="hover-card-content"]')?.textContent).toBe(message)
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
  ])('uses theme-aware colors for the $label tooltip and arrow', async (testCase) => {
    const model = viewModel()
    model.historyItem.references = testCase.references
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={model} />
      </TooltipProvider>
    )

    fireEvent.pointerMove(screen.getByText(testCase.trigger), { pointerType: 'mouse' })

    await waitFor(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"]')
      expect(tooltip?.textContent).toContain(testCase.content)
      expect(tooltip?.classList.contains('bg-popover')).toBe(true)
      expect(tooltip?.classList.contains('text-popover-foreground')).toBe(true)
      const arrow = tooltip?.querySelector('svg')
      expect(arrow?.classList.contains('fill-popover')).toBe(true)
      expect(arrow?.classList.contains('bg-foreground')).toBe(false)
    })
  })

  it('uses a theme-aware hover card for the full commit message', async () => {
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel()} />
      </TooltipProvider>
    )

    fireEvent.pointerEnter(screen.getByText(subject), { pointerType: 'mouse' })

    await waitFor(() => {
      const preview = document.querySelector('[data-slot="hover-card-content"]')
      expect(preview?.textContent).toBe(message)
      expect(preview?.classList.contains('text-popover-foreground')).toBe(true)
      expect(preview?.classList.contains('overflow-y-auto')).toBe(true)
      expect(preview?.classList.contains('whitespace-pre-wrap')).toBe(true)
      expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
    })
  })

  it('falls back to the subject when a commit has no message', async () => {
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel('')} />
      </TooltipProvider>
    )

    fireEvent.pointerEnter(screen.getByText(subject), { pointerType: 'mouse' })

    await waitFor(() => {
      expect(document.querySelector('[data-slot="hover-card-content"]')?.textContent).toBe(subject)
    })
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

  it('does not expand the row when selecting the preview text', async () => {
    const onToggleExpand = vi.fn()
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel()} onToggleExpand={onToggleExpand} />
      </TooltipProvider>
    )

    fireEvent.pointerEnter(screen.getByText(subject), { pointerType: 'mouse' })
    const preview = await waitFor(() => {
      const content = document.querySelector('[data-slot="hover-card-content"]')
      expect(content).not.toBeNull()
      if (!content) {
        throw new Error('Commit preview did not open')
      }
      return content
    })
    fireEvent.click(preview)

    expect(onToggleExpand).not.toHaveBeenCalled()
  })
})
