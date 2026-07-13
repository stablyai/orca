// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ResourceSessionCleanupReview,
  ResourceSessionCleanupReviewState
} from './resource-session-cleanup-review'
import { ResourceSessionCleanupDialog } from './ResourceSessionCleanupDialog'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce(
          (text, [token, value]) => text.replace(`{{${token}}}`, String(value)),
          fallback
        )
      : fallback
}))

function review(
  overrides: Partial<ResourceSessionCleanupReview> = {}
): ResourceSessionCleanupReview {
  return {
    reviewedIds: ['idle', 'agent', 'unknown'],
    inspections: [
      { id: 'idle', safety: 'inactive' },
      { id: 'agent', safety: 'active' },
      { id: 'unknown', safety: 'unknown' }
    ],
    inactiveIds: ['idle'],
    activeCount: 1,
    unknownCount: 1,
    goneCount: 0,
    ...overrides
  }
}

function renderDialog(state: ResourceSessionCleanupReviewState): void {
  render(
    <ResourceSessionCleanupDialog
      state={state}
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
}

describe('ResourceSessionCleanupDialog', () => {
  it('shows activity checking without an enabled destructive action', () => {
    renderDialog({ phase: 'reviewing' })

    expect(screen.getByText('Checking current process activity…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Kill/ })).toBeNull()
  })

  it('protects active and unknown sessions while offering only inactive cleanup', () => {
    renderDialog({ phase: 'ready', review: review() })

    expect(screen.getByText('1 inactive terminal can be closed.')).toBeTruthy()
    expect(screen.getByText('2 active or unverified terminals will be protected.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Kill 1 inactive terminal' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it('does not enable cleanup when every reviewed session is protected', () => {
    renderDialog({
      phase: 'ready',
      review: review({
        reviewedIds: ['agent'],
        inspections: [{ id: 'agent', safety: 'active' }],
        inactiveIds: [],
        activeCount: 1,
        unknownCount: 0
      })
    })

    expect(
      (
        screen.getByRole('button', {
          name: 'No inactive terminals to kill'
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it('locks dismissal and shows the canonical loader while cleanup runs', () => {
    renderDialog({ phase: 'running', review: review() })

    expect(screen.getByText('Closing confirmed inactive terminals…')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Closing…' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(document.querySelector('.animate-spin')).not.toBeNull()
  })

  it('reports every final outcome without exposing reviewed ids', () => {
    renderDialog({
      phase: 'completed',
      review: review(),
      result: { killedCount: 1, protectedCount: 2, goneCount: 3, failedCount: 4 }
    })

    expect(screen.getByText('Closed: 1. Protected: 2. Already gone: 3. Failed: 4.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('agent')
    expect(document.body.textContent).not.toContain('unknown')
  })

  it('shows retry after an error without offering cleanup', () => {
    renderDialog({ phase: 'error', operation: 'review', code: 'review-failed' })

    expect(screen.getByText('Unable to check current terminal activity.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(
      false
    )
    expect(screen.queryByRole('button', { name: /^Kill/ })).toBeNull()
  })
})
