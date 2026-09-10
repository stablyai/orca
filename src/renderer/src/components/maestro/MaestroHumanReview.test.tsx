// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaestroHumanReview as Review } from '../../../../shared/maestro-human-review'
import { MaestroHumanReview, urgentHumanReviewCount } from './MaestroHumanReview'

const human = {
  actor_id: 'human-1',
  kind: 'user' as const,
  authenticated: true as const,
  session_id: 'session-1'
}

function review(state: Review['state'], suffix = state): Review {
  const approved = ['approved_for_submit', 'submitted', 'expired'].includes(state)
  return {
    schema_version: 1,
    protocol: 'maestro-human-review/v1',
    review_id: `review-${suffix}`,
    workspace: {
      repository_id: 'repo-1',
      execution_host_id: 'local',
      workspace_key: 'folder:workspace-1',
      run_id: 'run-1'
    },
    coordinator_generation: 2,
    task_id: `task-${suffix}`,
    dispatch_id: `dispatch-${suffix}`,
    title: `Application ${suffix}`,
    summary: 'Review the prepared application.',
    state,
    references: {
      fields: [{ document_ref: 'document-1', field_path: 'contact.email', label: 'Email' }],
      documents: [{ document_ref: 'document-1', revision: 'revision-1', title: 'Application' }],
      browser: { surface_id: `surface-${suffix}`, browser_page_id: `page-${suffix}` }
    },
    decisions: [{ decision_id: 'contact-email', prompt: 'Confirm the contact email.' }],
    unresolved_decisions: approved
      ? []
      : [{ decision_id: 'contact-email', prompt: 'Confirm the contact email.' }],
    staged_receipt: {
      receipt_id: `stage-${suffix}`,
      actor: { ...human, kind: 'worker' },
      state: state === 'needs_input' ? 'needs_input' : 'staged',
      recorded_at: '2026-08-31T12:00:00.000Z'
    },
    approval_receipt: approved
      ? {
          receipt_id: `approval-${suffix}`,
          actor: human,
          decision_resolutions: [{ decision_id: 'contact-email', resolution: 'Confirmed.' }],
          recorded_at: '2026-08-31T12:05:00.000Z',
          expires_at: '2026-09-01T12:05:00.000Z'
        }
      : null,
    submission_receipt:
      state === 'submitted'
        ? {
            receipt_id: 'submission-1',
            actor: human,
            submission_reference: 'confirmation-42',
            recorded_at: '2026-08-31T12:10:00.000Z'
          }
        : null,
    rejection_receipt:
      state === 'rejected'
        ? {
            receipt_id: 'rejection-1',
            actor: human,
            reason: 'Contact details are incomplete.',
            recorded_at: '2026-08-31T12:10:00.000Z'
          }
        : null,
    expiration_receipt:
      state === 'expired'
        ? {
            receipt_id: 'expired-review-expired',
            expired_at: '2026-09-01T12:05:00.000Z',
            recorded_at: '2026-09-01T12:06:00.000Z'
          }
        : null,
    created_at: '2026-08-31T12:00:00.000Z',
    updated_at: '2026-08-31T12:10:00.000Z'
  }
}

const baseProps = {
  status: 'ready' as const,
  reviews: [] as Review[],
  error: null,
  onRefresh: vi.fn(async () => undefined),
  onTransition: vi.fn(async () => undefined),
  onFocusBrowser: vi.fn(async () => undefined)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MaestroHumanReview', () => {
  it('renders loading, empty, and recoverable error states', () => {
    const { rerender } = render(<MaestroHumanReview {...baseProps} status="loading" />)
    expect(screen.getByText('Loading review items…')).not.toBeNull()

    rerender(<MaestroHumanReview {...baseProps} />)
    expect(screen.getByText('No applications need review.')).not.toBeNull()

    rerender(<MaestroHumanReview {...baseProps} status="error" error="Authority unavailable" />)
    expect(screen.getByRole('alert').textContent).toContain('Authority unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(baseProps.onRefresh).toHaveBeenCalledOnce()
  })

  it('shows every authoritative state without exposing raw IDs as row labels', () => {
    const reviews = [
      review('staged'),
      review('needs_input'),
      review('approved_for_submit'),
      review('submitted'),
      review('expired'),
      review('rejected')
    ]
    render(<MaestroHumanReview {...baseProps} reviews={reviews} />)

    for (const label of [
      'Staged',
      'Needs input',
      'Approved for submit',
      'Submitted',
      'Approval expired',
      'Rejected'
    ]) {
      expect(screen.getByText(label)).not.toBeNull()
    }
    expect(screen.queryByText('task-staged')).toBeNull()
    expect(urgentHumanReviewCount(reviews)).toBe(4)
  })

  it('keeps Browser Focus separate and creates an explicit approval receipt request', async () => {
    const needsInput = review('needs_input')
    render(<MaestroHumanReview {...baseProps} reviews={[needsInput]} />)
    fireEvent.click(screen.getByRole('button', { name: /Application needs_input/ }))

    expect(screen.getByText('Exact Browser surface attached')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browser Focus' }))
    await waitFor(() => expect(baseProps.onFocusBrowser).toHaveBeenCalledWith(needsInput))
    expect(baseProps.onTransition).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('Record the human decision…'), {
      target: { value: 'Use the verified contact email.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve for submit' }))
    await waitFor(() =>
      expect(baseProps.onTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          review_id: needsInput.review_id,
          action: 'approve',
          decision_resolutions: [
            { decision_id: 'contact-email', resolution: 'Use the verified contact email.' }
          ]
        })
      )
    )
  })

  it('records submission only from the approved action', () => {
    const approved = review('approved_for_submit')
    render(<MaestroHumanReview {...baseProps} reviews={[approved]} />)
    fireEvent.click(screen.getByRole('button', { name: /Application approved_for_submit/ }))
    fireEvent.change(screen.getByPlaceholderText('Receipt or confirmation reference…'), {
      target: { value: 'confirmation-99' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record submission' }))

    expect(baseProps.onTransition).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'submit', submission_reference: 'confirmation-99' })
    )
  })
})
