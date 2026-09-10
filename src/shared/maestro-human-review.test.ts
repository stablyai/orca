import { describe, expect, it } from 'vitest'
import {
  MaestroHumanReviewCreateRequestSchema,
  MaestroHumanReviewSchema,
  MaestroHumanReviewTransitionRequestSchema
} from './maestro-human-review'

const workspace = {
  repository_id: 'repo-1',
  execution_host_id: 'local',
  workspace_key: 'folder:workspace-1',
  run_id: 'run-1'
}

const actor = {
  actor_id: 'human-1',
  kind: 'user' as const,
  authenticated: true as const,
  session_id: 'session-1'
}

function review() {
  return {
    schema_version: 1 as const,
    protocol: 'maestro-human-review/v1' as const,
    review_id: 'review-1',
    workspace,
    coordinator_generation: 2,
    task_id: 'task-1',
    dispatch_id: 'dispatch-1',
    title: 'Submit application',
    summary: 'Review the final application before submission.',
    state: 'needs_input' as const,
    references: {
      fields: [{ document_ref: 'document-1', field_path: 'contact.email', label: 'Email' }],
      documents: [{ document_ref: 'document-1', revision: 'revision-4', title: 'Application' }],
      browser: { surface_id: 'surface-1', browser_page_id: 'page-1' }
    },
    decisions: [{ decision_id: 'decision-1', prompt: 'Confirm the contact email.' }],
    unresolved_decisions: [{ decision_id: 'decision-1', prompt: 'Confirm the contact email.' }],
    staged_receipt: {
      receipt_id: 'request-1',
      actor: { ...actor, kind: 'worker' as const },
      state: 'needs_input' as const,
      recorded_at: '2026-08-31T12:00:00.000Z'
    },
    approval_receipt: null,
    submission_receipt: null,
    rejection_receipt: null,
    expiration_receipt: null,
    created_at: '2026-08-31T12:00:00.000Z',
    updated_at: '2026-08-31T12:00:00.000Z'
  }
}

describe('Maestro human review contract', () => {
  it('requires immutable review references and explicit unresolved decisions', () => {
    expect(MaestroHumanReviewSchema.parse(review())).toMatchObject({
      state: 'needs_input',
      unresolved_decisions: [{ decision_id: 'decision-1' }]
    })

    const invalid = review()
    invalid.references = { fields: [], documents: [], browser: null } as never
    expect(() => MaestroHumanReviewSchema.parse(invalid)).toThrow('immutable reference')
  })

  it('limits creation to worker-safe staged states', () => {
    const request = {
      request_id: 'request-1',
      workspace,
      coordinator_generation: 2,
      review_id: 'review-1',
      task_id: 'task-1',
      dispatch_id: 'dispatch-1',
      title: 'Submit application',
      summary: 'Review before submission.',
      state: 'submitted',
      references: review().references,
      decisions: []
    }
    expect(() => MaestroHumanReviewCreateRequestSchema.parse(request)).toThrow()
  })

  it('requires explicit human transition payloads instead of navigation events', () => {
    const approval = MaestroHumanReviewTransitionRequestSchema.parse({
      request_id: 'approve-request-1',
      workspace,
      review_id: 'review-1',
      action: 'approve',
      receipt_id: 'approval-1',
      decision_resolutions: [{ decision_id: 'decision-1', resolution: 'Confirmed.' }],
      expires_at: '2026-09-01T12:00:00.000Z'
    })
    const submission = MaestroHumanReviewTransitionRequestSchema.parse({
      request_id: 'submit-request-1',
      workspace,
      review_id: 'review-1',
      action: 'submit',
      receipt_id: 'submission-1',
      submission_reference: 'confirmation-42'
    })

    expect(approval.action).toBe('approve')
    expect(submission).toMatchObject({ action: 'submit', submission_reference: 'confirmation-42' })
    expect(() =>
      MaestroHumanReviewTransitionRequestSchema.parse({
        request_id: 'submit-request-2',
        workspace,
        review_id: 'review-1',
        action: 'submit',
        receipt_id: 'submission-2',
        url: 'https://example.com/success'
      })
    ).toThrow()
  })
})
