import {
  loadMobileMaestroHumanReviews,
  resolveRetainedReviewBrowser
} from '../../../../mobile/src/maestro/mobile-maestro-human-review'
import { OrchestrationDb } from '../../../../src/main/runtime/orchestration/db/orchestration-db'
import {
  createMaestroHumanReview,
  transitionMaestroHumanReview
} from '../../../../src/main/runtime/orchestration/db/maestro/maestro-human-review-store'
import { MaestroRunProgressV2Schema } from '../../../../src/shared/maestro-run-progress'
import type { WorkspaceSurfaceSnapshot } from '../../../../src/shared/maestro-workspace-canvas'

function createProgressFixture() {
  return MaestroRunProgressV2Schema.parse({
    schema_version: 2,
    run: { id: 'run-career-ops', title: 'Career Ops application run' },
    execution: {
      state: 'completed_with_failures',
      progress_percent: 100,
      completed: 2,
      total: 2,
      counts: {
        pending: 0,
        running: 0,
        input_required: 0,
        blocked: 0,
        succeeded: 1,
        failed: 1,
        cancelled: 0
      }
    },
    deliverables: { progress_percent: 100, completed: 1, total: 1 },
    operational_reliability: { successful: 1, failed: 0, superseded: 1, unverifiable: 1 },
    projection_health: { state: 'partial', revision: 7, warning: 'One attempt is unverifiable.' },
    cleanup_health: { state: 'pending', count: 1, warning: 'One retained review remains.' },
    current: [],
    recently_completed: [
      {
        reference: 'task-deliverable',
        title: 'Prepare application',
        outcome_summary: 'Application prepared.',
        purpose: 'deliverable'
      },
      {
        reference: 'attempt-old',
        title: 'Recover launch',
        outcome_summary: 'Superseded by a verified replacement.',
        purpose: 'operational',
        operational_outcome: 'superseded',
        successor_reference: 'attempt-new'
      }
    ],
    next: [],
    blocked: [],
    nested_activity: [],
    technical: {
      execution_host_id: 'local',
      workspace_key: 'folder:career-ops',
      run_id: 'run-career-ops',
      revision: 7
    }
  })
}

export async function exerciseWorkflowReviewAndMobile() {
  const progress = createProgressFixture()
  const database = new OrchestrationDb(':memory:')
  try {
    const run = database.createRun({
      objective: 'Career Ops application run',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const workspace = {
      repository_id: 'repo-career-ops',
      execution_host_id: 'local',
      workspace_key: 'folder:career-ops',
      run_id: run.id
    }
    const task = database.createTask({ spec: 'Prepare application', runId: run.id })
    const dispatch = database.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'worker-career-ops',
      creator: { kind: 'system' },
      maxDepth: 4
    })
    const worker = {
      actor_id: 'worker-career-ops',
      kind: 'worker' as const,
      authenticated: true as const,
      session_id: 'worker-session'
    }
    const human = {
      actor_id: 'human-career-ops',
      kind: 'user' as const,
      authenticated: true as const,
      session_id: 'human-session'
    }
    const consent = database.grantMaestroBrowserProfileConsent(
      {
        schema_version: 1,
        protocol: 'maestro-browser-profile-consent/v1',
        workspace,
        profile_id: 'profile-career-ops',
        task_id: task.id,
        attempt_id: dispatch.id,
        expires_at: '2099-09-01T00:00:00.000Z'
      },
      human,
      new Date('2026-08-31T20:00:00.000Z')
    )
    const browserRequest = {
      schema_version: 1 as const,
      protocol: 'maestro-browser-surface/v1' as const,
      request_id: 'browser-career-ops',
      workspace,
      actor: worker,
      coordinator_generation: 1,
      task_id: task.id,
      attempt_id: dispatch.id,
      agent_id: 'opencode',
      url: 'https://user:secret@example.com/application?token=secret#private',
      title: 'Career application',
      profile_id: consent.profile_id,
      profile_consent_receipt: consent,
      requested_visibility: 'visible' as const,
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      retention: 'retain' as const,
      ownership: 'harness' as const,
      evidence: {
        route_or_component: 'Career application',
        state: 'review',
        theme: 'dark' as const,
        source_revision: 'revision-7',
        capture_mode: 'native-viewport' as const
      }
    }
    const reserved = database.reserveMaestroBrowserSurface(browserRequest)
    const retained = database.updateMaestroBrowserSurface(
      reserved.receipt.surface_id,
      (receipt) => ({ ...receipt, state: 'retained', observed_visibility: 'visible' })
    ).receipt
    if (!retained.browser_page_id) {
      throw new Error('The retained Browser fixture has no exact page identity.')
    }
    const review = createMaestroHumanReview(
      database,
      {
        request_id: 'review-request-career-ops',
        workspace,
        coordinator_generation: 1,
        review_id: 'review-career-ops',
        task_id: task.id,
        dispatch_id: dispatch.id,
        title: 'Review career application',
        summary: 'Confirm the application before submission.',
        state: 'needs_input',
        references: {
          fields: [{ document_ref: 'application', field_path: 'salary', label: 'Salary' }],
          documents: [{ document_ref: 'resume.pdf', revision: '7', title: 'Tailored resume' }],
          browser: {
            surface_id: retained.surface_id,
            browser_page_id: retained.browser_page_id,
            profile_consent_receipt: consent
          }
        },
        decisions: [{ decision_id: 'salary', prompt: 'Confirm expected salary.' }]
      },
      worker,
      new Date('2026-08-31T20:01:00.000Z')
    )
    const approved = transitionMaestroHumanReview(
      database,
      {
        request_id: 'approve-career-ops',
        workspace,
        review_id: review.review_id,
        action: 'approve',
        receipt_id: 'approval-career-ops',
        decision_resolutions: [{ decision_id: 'salary', resolution: 'Use the posted range.' }],
        expires_at: '2026-09-01T20:00:00.000Z'
      },
      human,
      new Date('2026-08-31T20:02:00.000Z')
    )
    const submitted = transitionMaestroHumanReview(
      database,
      {
        request_id: 'submit-career-ops',
        workspace,
        review_id: review.review_id,
        action: 'submit',
        receipt_id: 'submission-career-ops',
        submission_reference: 'confirmation-42'
      },
      human,
      new Date('2026-08-31T20:03:00.000Z')
    )
    const authority = {
      workspace,
      coordinatorGeneration: 1,
      retainedBrowsers: [
        { surfaceId: retained.surface_id, browserPageId: retained.browser_page_id }
      ]
    }
    const snapshot = {
      surfaces: {
        browser: {
          id: {
            execution_host_id: workspace.execution_host_id,
            workspace_key: workspace.workspace_key,
            unified_tab_id: 'tab-browser-career-ops'
          },
          title: 'Career application',
          binding: { kind: 'browser', browser_page_id: retained.browser_page_id }
        }
      }
    } as unknown as WorkspaceSurfaceSnapshot
    const exactMobileSurface = resolveRetainedReviewBrowser(review, authority, snapshot)
    const mixedVersion = await loadMobileMaestroHumanReviews(
      {
        sendRequest: async () => ({
          ok: false as const,
          error: { code: 'method_not_found', message: 'Unknown RPC method' }
        })
      } as never,
      { execution_host_id: 'local', workspace_key: workspace.workspace_key }
    )
    const revoked = database.revokeMaestroBrowserProfileConsent(
      {
        schema_version: 1,
        protocol: 'maestro-browser-profile-consent/v1',
        workspace,
        consent_id: consent.consent_id
      },
      new Date('2026-08-31T20:04:00.000Z')
    )
    return {
      deliverablesPercent: progress.deliverables?.progress_percent,
      reliability: progress.operational_reliability,
      runLabel: progress.run.title,
      projectionRevision: progress.projection_health.revision,
      browserIdentityStable: retained.surface_id === reserved.receipt.surface_id,
      browserUrlSanitized:
        retained.url === 'https://example.com/application' &&
        !retained.url.includes('secret') &&
        !JSON.stringify(retained).includes('token=secret'),
      consentRevoked: revoked.revoked_at !== null,
      reviewStates: [review.state, approved.state, submitted.state],
      exactMobileTab: exactMobileSurface?.id.unified_tab_id ?? null,
      mixedVersionState: mixedVersion.status
    }
  } finally {
    database.close()
  }
}
