import { describe, expect, it } from 'vitest'
import { advanceWorkflowRun, type WorkflowSchedulerAction } from './workflow-scheduler'
import { createWorkflowRunRecord, currentWorkflowTask } from './workflow-run-state'
import {
  completeWorkflowTask,
  failWorkflowTaskAttempt,
  resolveWorkflowApproval,
  retryWorkflowTask
} from './workflow-task-settlement'
import { authenticationFeatureTemplate, workflowTemplates } from './workflow-templates-team'
import type { WorkflowDefinition } from './workflow-definition-schema'
import type { WorkflowRun } from './workflow-run-types'
import type { WorkflowWorkerReport } from './workflow-worker-result'
import {
  agentNode,
  chain,
  defaultWorkflowPolicies,
  dependency,
  endNode,
  startNode
} from './workflow-template-builders'

const AT = '2026-11-03T10:00:00.000Z'

function runOf(definition: WorkflowDefinition): WorkflowRun {
  return createWorkflowRunRecord({
    id: 'wfr_test',
    presetId: 'p',
    presetName: 'P',
    objective: 'Build auth',
    definition,
    placement: { worktreeSelector: 'id:wt', worktreeLabel: 'wt' },
    at: AT
  })
}

function report(
  outcome: 'succeeded' | 'failed',
  data: Record<string, unknown> = {}
): WorkflowWorkerReport {
  return {
    outcome,
    subject: outcome,
    summary: 'did the work',
    data,
    dataError: null,
    filesModified: [],
    reportPath: null,
    messageId: null,
    completedAt: AT
  }
}

function dispatched(actions: WorkflowSchedulerAction[]): string[] {
  return actions.flatMap((action) => (action.kind === 'dispatch-agent' ? [action.taskKey] : []))
}

/** What the controller does on a dispatch action: record one attempt. */
function start(run: WorkflowRun, taskKey: string): void {
  const task = run.tasks[taskKey]
  task.dispatches.push({
    attempt: task.dispatches.length + 1,
    requestId: `${taskKey}:${task.dispatches.length + 1}`,
    orcaDispatchId: `d_${taskKey}_${task.dispatches.length + 1}`,
    orcaTerminalHandle: null,
    orcaPaneKey: null,
    orcaWorktreeId: null,
    state: 'running',
    requested: null,
    effective: null,
    startedAt: AT,
    settledAt: null,
    error: null
  })
  task.status = 'running'
}

function finish(
  run: WorkflowRun,
  nodeId: string,
  data: Record<string, unknown> = {}
): WorkflowSchedulerAction[] {
  const key = currentWorkflowTask(run, nodeId).key
  expect(completeWorkflowTask(run, key, report('succeeded', data), AT)).toBe('settled')
  const actions = advanceWorkflowRun(run, AT)
  dispatched(actions).forEach((taskKey) => start(run, taskKey))
  return actions
}

describe('workflow scheduler', () => {
  it('runs the authentication example: plan, parallel build, joined review, approval', () => {
    const run = runOf(authenticationFeatureTemplate().definition)
    const first = advanceWorkflowRun(run, AT)
    expect(dispatched(first)).toEqual(['coordinator#0'])
    start(run, 'coordinator#0')

    expect(
      dispatched(finish(run, 'coordinator', { tasks: { backend: 'api', frontend: 'ui' } }))
    ).toEqual(['backend#0', 'frontend#0'])
    // The join holds the reviewer until both branches settle.
    expect(dispatched(finish(run, 'backend'))).toEqual([])
    expect(dispatched(finish(run, 'frontend'))).toEqual(['reviewer#0'])
    const last = finish(run, 'reviewer', { verdict: 'approved', findings: [] })

    expect(last.at(-1)).toEqual({ kind: 'finalize', status: 'completed', reason: null })
    expect(run.status).toBe('completed')
    expect(currentWorkflowTask(run, 'end').status).toBe('completed')
    expect(run.finalOutput).toContain('## Reviewer')
  })

  it('sends a rejected review back through a bounded revision loop, then fails at the limit', () => {
    const run = runOf(authenticationFeatureTemplate().definition)
    advanceWorkflowRun(run, AT).forEach(
      (action) => action.kind === 'dispatch-agent' && start(run, action.taskKey)
    )
    for (let revision = 0; revision < 3; revision += 1) {
      finish(run, 'coordinator', { tasks: {} })
      finish(run, 'backend')
      finish(run, 'frontend')
      const actions = finish(run, 'reviewer', { verdict: 'rejected', findings: ['no tests'] })
      if (revision < 2) {
        expect(dispatched(actions)).toEqual([`coordinator#${revision + 1}`])
        expect(run.tasks[`coordinator#${revision + 1}`].activation).toBe('loop')
      } else {
        expect(actions.at(-1)).toMatchObject({ kind: 'finalize', status: 'failed' })
      }
    }
    expect(run.loopCounts['x-decision-coordinator-loop']).toBe(2)
    expect(run.error).toContain('Revision limit reached')
  })

  it('rejects a report for a superseded iteration', () => {
    const run = runOf(authenticationFeatureTemplate().definition)
    advanceWorkflowRun(run, AT).forEach(
      (action) => action.kind === 'dispatch-agent' && start(run, action.taskKey)
    )
    finish(run, 'coordinator')
    expect(completeWorkflowTask(run, 'coordinator#0', report('succeeded'), AT)).toBe('stale')
  })

  it('retries a failed attempt while attempts remain, then fails the run fail-fast', () => {
    const definition: WorkflowDefinition = {
      nodes: [
        startNode(),
        agentNode('agent', 'worker', 'Worker', { role: 'w', instructions: 'work', maxAttempts: 2 }),
        endNode()
      ],
      dependencies: chain('start', 'worker', 'end'),
      communication: [],
      policies: defaultWorkflowPolicies()
    }
    const run = runOf(definition)
    advanceWorkflowRun(run, AT).forEach(
      (action) => action.kind === 'dispatch-agent' && start(run, action.taskKey)
    )

    expect(failWorkflowTaskAttempt(run, 'worker#0', 'crashed', AT)).toBe('retry')
    expect(dispatched(advanceWorkflowRun(run, AT))).toEqual(['worker#0'])
    start(run, 'worker#0')
    expect(failWorkflowTaskAttempt(run, 'worker#0', 'crashed again', AT)).toBe('failed')
    expect(advanceWorkflowRun(run, AT).at(-1)).toMatchObject({ kind: 'finalize', status: 'failed' })

    expect(retryWorkflowTask(run, 'worker#0', AT)).toBe(true)
    expect(run.status).toBe('running')
    expect(currentWorkflowTask(run, 'end').status).toBe('pending')
    expect(dispatched(advanceWorkflowRun(run, AT))).toEqual(['worker#0'])
  })

  it('stops dispatching while paused and honours the concurrency limit on resume', () => {
    const definition = authenticationFeatureTemplate().definition
    definition.policies.maxConcurrentAgents = 1
    const run = runOf(definition)
    advanceWorkflowRun(run, AT).forEach(
      (action) => action.kind === 'dispatch-agent' && start(run, action.taskKey)
    )
    run.schedulingPaused = true
    expect(dispatched(finish(run, 'coordinator'))).toEqual([])
    run.schedulingPaused = false
    expect(dispatched(advanceWorkflowRun(run, AT))).toEqual(['backend#0'])
  })

  it('routes an approval rejection away from the approved path', () => {
    const definition: WorkflowDefinition = {
      nodes: [
        startNode(),
        { id: 'gate', label: 'Ship?', kind: 'approval', question: 'Ship it?' },
        endNode()
      ],
      dependencies: [dependency('start', 'gate'), dependency('gate', 'end')],
      communication: [],
      policies: defaultWorkflowPolicies()
    }
    const approved = runOf(definition)
    expect(advanceWorkflowRun(approved, AT)).toEqual([
      { kind: 'request-approval', taskKey: 'gate#0' }
    ])
    expect(approved.status).toBe('awaiting-approval')
    resolveWorkflowApproval(approved, 'gate#0', 'approved', AT)
    expect(advanceWorkflowRun(approved, AT).at(-1)).toMatchObject({ status: 'completed' })

    const rejected = runOf(definition)
    advanceWorkflowRun(rejected, AT)
    resolveWorkflowApproval(rejected, 'gate#0', 'rejected', AT)
    expect(advanceWorkflowRun(rejected, AT).at(-1)).toMatchObject({
      status: 'failed',
      reason: 'No End node was reached.'
    })
  })

  it('can start every shipped template', () => {
    for (const template of workflowTemplates()) {
      const run = runOf(template.definition)
      expect(dispatched(advanceWorkflowRun(run, AT)).length, template.name).toBeGreaterThan(0)
    }
  })
})
