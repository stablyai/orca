import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  workflowTemplates,
  authenticationFeatureTemplate
} from '../../../../shared/workflow/workflow-templates-team'
import {
  createWorkflowRunRecord,
  currentWorkflowTask
} from '../../../../shared/workflow/workflow-run-state'
import { advanceWorkflowRun } from '../../../../shared/workflow/workflow-scheduler'
import { completeWorkflowTask } from '../../../../shared/workflow/workflow-task-settlement'
import { computeWorkflowMetrics } from '../../../../shared/workflow/workflow-metrics'
import type { WorkflowRun } from '../../../../shared/workflow/workflow-run-types'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { useWorkflowRunViewStore } from './workflow-run-view-store'
import { ConfirmationDialogProvider } from '../confirmation-dialog'
import WorkflowsPage from './WorkflowsPage'

const FRAME = { width: 1280 }

function Frame(): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div style={{ height: 900 }} className="flex">
        <WorkflowsPage />
      </div>
    </ConfirmationDialogProvider>
  )
}

/** Answer the workflow RPCs the page makes so it renders without a runtime. */
function stubWorkflowRuntime(run: WorkflowRun | null): void {
  const answer = (method: string): unknown => {
    switch (method) {
      case 'workflow.presetList':
        return { presets: workflowTemplates() }
      case 'workflow.runList':
        return {
          runs: run
            ? [
                {
                  id: run.id,
                  presetId: run.presetId,
                  presetName: run.presetName,
                  objective: run.objective,
                  status: run.status,
                  createdAt: run.createdAt,
                  startedAt: run.startedAt,
                  settledAt: run.settledAt,
                  error: run.error
                }
              ]
            : []
        }
      case 'workflow.runGet':
        return run ? { run: { ...run, events: [] }, metrics: computeWorkflowMetrics(run) } : null
      default:
        return {}
    }
  }
  const call: typeof window.api.runtime.call = async ({ method }) => ({
    id: 'fixture',
    ok: true,
    result: answer(method),
    _meta: { runtimeId: 'fixture' }
  })
  window.api.runtime.call = call
}

/** A run partway through: plan done, both builders done, review in flight, driven by the real scheduler. */
function midRun(): WorkflowRun {
  const at = (offsetSeconds: number) =>
    new Date(Date.parse('2026-11-03T10:00:00.000Z') + offsetSeconds * 1000).toISOString()
  const run = createWorkflowRunRecord({
    id: 'wfr_fixture-0001',
    presetId: 'template-authentication-feature',
    presetName: 'Authentication Feature',
    objective: authenticationFeatureTemplate().defaultRunSettings.objective,
    definition: authenticationFeatureTemplate().definition,
    placement: { worktreeSelector: 'id:repo::/work/auth', worktreeLabel: 'auth' },
    at: at(0)
  })
  run.startedAt = at(0)
  run.orcaRunId = 'run_7c1e0a3f'
  const start = (key: string, seconds: number, agent: string) => {
    const task = run.tasks[key]
    task.status = 'running'
    task.startedAt = at(seconds)
    task.orcaTaskId = `task_${key.replace(/\W/g, '')}`
    task.dispatches.push({
      attempt: 1,
      requestId: `${key}:1`,
      orcaDispatchId: `ctx_${key.replace(/\W/g, '').slice(0, 8)}`,
      orcaTerminalHandle: `term_${key.split('#')[0]}`,
      orcaPaneKey: null,
      orcaWorktreeId: null,
      state: 'running',
      requested: { agent, model: null, effort: null, allowModelFallback: false },
      effective: { agent, model: null, effort: null },
      startedAt: at(seconds),
      settledAt: null,
      error: null
    })
  }
  const done = (
    key: string,
    seconds: number,
    subject: string,
    data: Record<string, unknown> = {}
  ) => {
    const dispatch = run.tasks[key].dispatches.at(-1)
    if (dispatch) {
      dispatch.state = 'succeeded'
      dispatch.settledAt = at(seconds)
    }
    completeWorkflowTask(
      run,
      key,
      {
        outcome: 'succeeded',
        subject,
        summary: `${subject}. Tests pass.`,
        data,
        dataError: null,
        filesModified: ['src/auth/login.ts'],
        reportPath: null,
        messageId: null,
        completedAt: at(seconds)
      },
      at(seconds)
    )
    advanceWorkflowRun(run, at(seconds))
  }
  advanceWorkflowRun(run, at(0))
  start('coordinator#0', 2, 'claude')
  done('coordinator#0', 95, 'Split into API and UI tasks', {
    tasks: { backend: 'Build /login', frontend: 'Build the form' },
    apiContract: 'POST /login'
  })
  start('backend#0', 97, 'codex')
  start('frontend#0', 98, 'claude')
  run.messages.push(
    ...(['backend', 'frontend'] as const).map((target, index) => ({
      id: `wfm_${index}`,
      runId: run.id,
      edgeId: `c-coordinator-${target}`,
      sourceNodeId: 'coordinator',
      destinationNodeId: target,
      taskKey: `${target}#0`,
      orcaDispatchId: null,
      orcaMessageId: null,
      type: 'task-assignment' as const,
      channel: 'controller' as const,
      timestamp: at(96),
      correlationId: `c${index}`,
      payload: target === 'backend' ? 'Build /login' : 'Build the form',
      payloadFormat: 'text' as const,
      deliveryState: 'delivered' as const,
      releasedAt: null,
      rejection: null,
      bytes: 14,
      estimatedTokens: 4
    })),
    {
      id: 'wfm_x',
      runId: run.id,
      edgeId: null,
      sourceNodeId: 'backend',
      destinationNodeId: 'frontend',
      taskKey: 'backend#0',
      orcaDispatchId: null,
      orcaMessageId: null,
      type: 'status-update',
      channel: 'direct',
      timestamp: at(140),
      correlationId: 'cx',
      payload: 'use my schema',
      payloadFormat: 'text',
      deliveryState: 'rejected',
      releasedAt: null,
      rejection: {
        code: 'route_not_permitted',
        reason: 'This workflow has no enabled route from backend to frontend.'
      },
      bytes: 13,
      estimatedTokens: 4
    }
  )
  done('frontend#0', 300, 'Login and registration screens built')
  done('backend#0', 410, 'Auth endpoints with hashing')
  start('reviewer#0', 412, 'codex')
  // Pin "now" near the fixture's clock so durations read like a live run.
  currentWorkflowTask(run, 'reviewer').startedAt = new Date(Date.now() - 95_000).toISOString()
  return run
}

export const design = defineFixture({
  ...FRAME,
  setup: () => {
    stubWorkflowRuntime(null)
    useWorkflowRunViewStore.getState().clear()
    useWorkflowEditorStore.getState().load(authenticationFeatureTemplate(), { saved: true })
    useWorkflowEditorStore.getState().setMode('design')
    useWorkflowEditorStore.getState().select({ kind: 'nodes', ids: ['backend'] })
  },
  render: () => <Frame />
})

export const routeSelected = defineFixture({
  ...FRAME,
  setup: () => {
    stubWorkflowRuntime(null)
    useWorkflowRunViewStore.getState().clear()
    useWorkflowEditorStore.getState().load(authenticationFeatureTemplate(), { saved: true })
    useWorkflowEditorStore.getState().setMode('design')
    useWorkflowEditorStore
      .getState()
      .select({ kind: 'communication', id: 'c-reviewer-coordinator' })
  },
  render: () => <Frame />
})

export const execution = defineFixture({
  ...FRAME,
  setup: () => {
    const run = midRun()
    stubWorkflowRuntime(run)
    useWorkflowEditorStore.getState().load(authenticationFeatureTemplate(), { saved: true })
    useWorkflowEditorStore.getState().setMode('execution')
    useWorkflowEditorStore.getState().select({ kind: 'nodes', ids: ['backend'] })
    useWorkflowRunViewStore.setState({
      target: null,
      runId: run.id,
      run,
      metrics: computeWorkflowMetrics(run),
      error: null,
      edgeActivity: {}
    })
  },
  render: () => <Frame />
})
