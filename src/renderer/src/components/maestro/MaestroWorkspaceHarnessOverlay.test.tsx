// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MaestroRunProgress,
  MaestroRunProgressV2
} from '../../../../shared/maestro-run-progress'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MaestroWorkspaceHarnessOverlay } from './MaestroWorkspaceHarnessOverlay'

const humanReview = {
  status: 'ready' as const,
  reviews: [],
  error: null,
  refresh: vi.fn(async () => undefined),
  transition: vi.fn(async () => undefined),
  focusBrowser: vi.fn(async () => undefined)
}

const activeProgress: MaestroRunProgressV2 = {
  schema_version: 2,
  run: { id: 'run_technical_id', title: 'Harden orchestration contracts' },
  execution: {
    state: 'active',
    progress_percent: 33,
    completed: 1,
    total: 3,
    counts: {
      pending: 1,
      running: 1,
      input_required: 0,
      blocked: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0
    }
  },
  projection_health: { state: 'healthy', revision: 7 },
  cleanup_health: { state: 'clean', count: 0 },
  current: [
    {
      reference: 'task_current_id',
      title: 'Desktop progress',
      worker_label: 'Frontend specialist',
      state: 'running',
      activity_summary: 'Building the expanded Run view'
    }
  ],
  recently_completed: [
    {
      reference: 'task_complete_id',
      title: 'Progress contract',
      outcome_summary: 'Added human activity fields'
    }
  ],
  next: [
    {
      reference: 'task_next_id',
      title: 'Integration evidence',
      next_step: 'Capture desktop and notebook states'
    }
  ],
  blocked: [],
  nested_activity: [
    {
      parent_reference: 'task_current_id',
      child_id: 'child_technical_id',
      label: 'Accessibility review',
      model: 'Codex',
      state: 'running',
      activity_summary: 'Checking focus and screen-reader names'
    }
  ],
  resources: [
    {
      kind: 'coordinator',
      reference: 'coordinator_technical_id',
      title: 'Coordinator',
      detail: 'Recovered from the current authenticated Run generation.',
      state: 'recovered'
    },
    {
      kind: 'task',
      reference: 'task_current_id',
      title: 'Desktop progress',
      detail: 'Work is active.',
      state: 'active'
    },
    {
      kind: 'attempt',
      reference: 'attempt_technical_id',
      parent_reference: 'dispatch_technical_id',
      title: 'Attempt 1 · Desktop progress',
      detail: 'Starting the provider execution.',
      state: 'loading'
    },
    {
      kind: 'dispatch',
      reference: 'dispatch_technical_id',
      parent_reference: 'task_current_id',
      title: 'Dispatch 1 · Desktop progress',
      detail: 'Worker dispatch is active.',
      state: 'active'
    },
    {
      kind: 'provider',
      reference: 'provider_technical_id',
      parent_reference: 'dispatch_technical_id',
      title: 'Codex provider execution',
      detail: 'Executing Desktop progress.',
      state: 'active'
    },
    {
      kind: 'terminal',
      reference: 'terminal_technical_id',
      parent_reference: 'attempt_technical_id',
      title: 'Desktop progress terminal',
      detail: 'Worker terminal is live.',
      state: 'active',
      surface_key: '["local","folder:workspace","tab-secret"]',
      terminal_handle: 'term_secret',
      liveness: 'live'
    },
    {
      kind: 'browser',
      reference: 'browser_technical_id',
      parent_reference: 'attempt_technical_id',
      title: 'Validation Browser',
      detail: 'https://example.test · visible',
      state: 'active',
      surface_key: '["local","folder:workspace","browser-secret"]'
    },
    {
      kind: 'cleanup',
      reference: 'cleanup_technical_id',
      parent_reference: 'terminal_technical_id',
      title: 'Desktop progress cleanup',
      detail: 'Terminal cleanup is unverifiable.',
      state: 'unverifiable'
    }
  ],
  technical: {
    execution_host_id: 'local',
    workspace_key: 'folder:workspace',
    run_id: 'run_technical_id',
    revision: 7
  }
}

const settledLegacyProgress: MaestroRunProgress = {
  available: true,
  authority: {
    runId: 'run-legacy',
    workspace: { executionHostId: 'local', workspaceKey: 'worktree:legacy' },
    revision: 5
  },
  summary: {
    schema_version: 1,
    state: 'partial',
    progress_percent: 60,
    task_counts: {
      approved: 6,
      running: 0,
      input_required: 0,
      blocked: 0,
      pending: 0,
      failed: 4
    },
    current_tasks: [],
    next_tasks: [],
    cleanup: {
      pending: { count: 0, ids: [], truncated: false },
      unverifiable: { count: 0, ids: [], truncated: false },
      failed: { count: 0, ids: [], truncated: false },
      retained: { count: 0, ids: [], truncated: false }
    },
    last_activity: null,
    blockers: Array.from({ length: 4 }, (_, index) => ({
      task_id: `failed-task-${index}`,
      attempt_id: null,
      finding_ref: null,
      cleanup_id: null
    })),
    material_findings: []
  }
}

function renderOverlay(
  overrides: Partial<React.ComponentProps<typeof MaestroWorkspaceHarnessOverlay>> = {}
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <MaestroWorkspaceHarnessOverlay
        progress={activeProgress}
        authorityUnavailable={false}
        visibility="expanded"
        onVisibilityChange={vi.fn()}
        onActivateReference={() => true}
        humanReview={humanReview}
        {...overrides}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('MaestroWorkspaceHarnessOverlay', () => {
  it('renders human Run, worker, activity, outcome, next-step, and nested labels', () => {
    renderOverlay()

    expect(screen.getByRole('heading', { name: 'Harden orchestration contracts' })).not.toBeNull()
    expect(screen.getByText('Running')).not.toBeNull()
    expect(screen.getByText('1 of 3 tasks')).not.toBeNull()
    expect(screen.getByText('Frontend specialist')).not.toBeNull()
    expect(screen.getByText('Building the expanded Run view')).not.toBeNull()
    expect(screen.getByText('Added human activity fields')).not.toBeNull()
    expect(screen.getByText('Capture desktop and notebook states')).not.toBeNull()
    expect(screen.getByText('Checking focus and screen-reader names')).not.toBeNull()
    expect(screen.queryByText('task_current_id')).toBeNull()
  })

  it('activates the exact bound surface and opens details when no binding exists', () => {
    const activate = vi.fn((reference: string) => reference === 'task_current_id')
    renderOverlay({ onActivateReference: activate })

    fireEvent.click(screen.getByRole('button', { name: /Desktop progress Frontend specialist/ }))
    fireEvent.click(screen.getByRole('button', { name: /Integration evidence/ }))

    expect(activate).toHaveBeenNthCalledWith(1, 'task_current_id')
    expect(activate).toHaveBeenNthCalledWith(2, 'task_next_id')
    expect(screen.getByText('task_next_id').closest('details')?.hasAttribute('open')).toBe(true)
  })

  it('shows first-class Run resources with truthful states while keeping raw identities technical', () => {
    const activate = vi.fn(() => true)
    renderOverlay({ onActivateReference: activate })

    const resources = screen.getByRole('region', { name: 'Run resources' })
    for (const label of [
      'Coordinator',
      'Task',
      'Attempt',
      'Dispatch',
      'Provider',
      'Terminal',
      'Browser',
      'Cleanup'
    ]) {
      expect(within(resources).getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(within(resources).getByText('Recovered')).not.toBeNull()
    expect(within(resources).getByText('Loading')).not.toBeNull()
    expect(within(resources).getByText('Unverifiable')).not.toBeNull()
    expect(screen.queryByText('term_secret')).toBeNull()
    expect(screen.queryByText('browser_technical_id')).toBeNull()

    const resourceButtons = within(resources).getAllByRole('button')
    const labels = resourceButtons.map((button) => button.textContent ?? '')
    expect(
      labels.findIndex((label) => label.includes('Dispatch 1 · Desktop progress'))
    ).toBeLessThan(labels.findIndex((label) => label.includes('Attempt 1 · Desktop progress')))
    expect(
      labels.findIndex((label) => label.includes('Attempt 1 · Desktop progress'))
    ).toBeLessThan(labels.findIndex((label) => label.includes('Desktop progress terminal')))
    expect(
      within(resources)
        .getByRole('button', { name: /Desktop progress terminal/ })
        .getAttribute('data-run-progress-depth')
    ).toBe('3')
    expect(
      within(resources)
        .getByRole('button', { name: /Codex provider execution/ })
        .getAttribute('data-run-progress-depth')
    ).toBe('2')

    fireEvent.click(within(resources).getByRole('button', { name: /Desktop progress terminal/ }))
    expect(activate).toHaveBeenCalledWith('["local","folder:workspace","tab-secret"]')
  })

  it('shows truthful completion beside an orthogonal cleanup warning', () => {
    renderOverlay({
      progress: {
        ...activeProgress,
        execution: {
          state: 'completed',
          progress_percent: 100,
          completed: 2,
          total: 2,
          counts: {
            pending: 0,
            running: 0,
            input_required: 0,
            blocked: 0,
            succeeded: 2,
            failed: 0,
            cancelled: 0
          }
        },
        cleanup_health: {
          state: 'unverifiable',
          count: 1,
          warning: 'Cleanup is unverifiable for one worker resource.'
        }
      }
    })

    expect(screen.getByText('Completed')).not.toBeNull()
    expect(screen.getByText('100%')).not.toBeNull()
    expect(screen.getAllByText('Cleanup').length).toBeGreaterThan(0)
    expect(screen.getByText(/Cleanup is unverifiable/)).not.toBeNull()
  })

  it('presents explicit completion without hiding waived work or cleanup health', () => {
    renderOverlay({
      progress: {
        ...activeProgress,
        completion: {
          state: 'completed',
          summary: 'Accepted the verified implementation.',
          evidence: ['Focused suite passed.'],
          waivers: [{ task_id: 'task_next_id', reason: 'Deferred to a follow-up.' }],
          completed_at: '2026-09-08T12:00:00.000Z',
          completed_by: { handle: 'term_coord', generation: 7 }
        },
        cleanup_health: {
          state: 'unverifiable',
          count: 1,
          warning: 'One resource remains unverifiable.'
        }
      }
    })

    expect(screen.getByText('Completed')).not.toBeNull()
    expect(screen.getByText('Accepted the verified implementation.')).not.toBeNull()
    expect(screen.getByText('Completed by term_coord, coordinator generation 7')).not.toBeNull()
    expect(screen.getByText('Focused suite passed.')).not.toBeNull()
    expect(screen.getByText(/Deferred to a follow-up/)).not.toBeNull()
    expect(screen.getByText('One resource remains unverifiable.')).not.toBeNull()
    expect(screen.getByText('1 of 3 tasks')).not.toBeNull()
  })

  it('separates deliverable readiness from operational reliability', () => {
    renderOverlay({
      progress: {
        ...activeProgress,
        deliverables: { completed: 2, total: 2, progress_percent: 100 },
        operational_reliability: {
          successful: 1,
          failed: 1,
          superseded: 1,
          unverifiable: 1
        }
      }
    })

    expect(screen.getByText('Deliverable readiness')).not.toBeNull()
    expect(
      screen.getByText(/1 successful · 1 failed · 1 superseded · 1 unverifiable/)
    ).not.toBeNull()
  })

  it('preserves urgent review count while compact or hidden', () => {
    const urgentReview = {
      ...humanReview,
      reviews: [{ state: 'needs_input' } as never]
    }
    const { rerender } = renderOverlay({ visibility: 'compact', humanReview: urgentReview })
    expect(screen.getByText('1 review')).not.toBeNull()

    rerender(
      <TooltipProvider>
        <MaestroWorkspaceHarnessOverlay
          progress={activeProgress}
          authorityUnavailable={false}
          visibility="hidden"
          onVisibilityChange={vi.fn()}
          onActivateReference={() => true}
          humanReview={urgentReview}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('1 review')).not.toBeNull()
  })

  it('shows settled legacy failures as completed work instead of blocked items', () => {
    renderOverlay({ progress: settledLegacyProgress })

    expect(screen.getByText('Completed with failures')).not.toBeNull()
    expect(screen.getByText('10 of 10 tasks')).not.toBeNull()
    expect(screen.getByText('100%')).not.toBeNull()
    expect(screen.queryByText(/Blocked item/)).toBeNull()
    expect(screen.queryByText(/failed-task-/)).toBeNull()
  })

  it('compacts, hides, and restores without mutating Run state', () => {
    const changeVisibility = vi.fn()
    const { rerender } = renderOverlay({
      visibility: 'compact',
      onVisibilityChange: changeVisibility
    })

    fireEvent.click(screen.getByRole('button', { name: 'Hide Run panel' }))
    expect(changeVisibility).toHaveBeenCalledWith('hidden')

    rerender(
      <TooltipProvider>
        <MaestroWorkspaceHarnessOverlay
          progress={activeProgress}
          authorityUnavailable={false}
          visibility="hidden"
          onVisibilityChange={changeVisibility}
          onActivateReference={() => true}
          humanReview={humanReview}
        />
      </TooltipProvider>
    )
    expect(document.querySelector('[data-maestro-workspace-harness-overlay]')).toBeNull()
    expect(document.querySelector('[data-maestro-run-restore-control]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore Run progress panel' }))
    expect(changeVisibility).toHaveBeenLastCalledWith('compact')
  })
})
