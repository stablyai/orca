import { describe, expect, it } from 'vitest'
import type { PipelineRunDetail } from '../../../../shared/pipelines-types'
import {
  buildPipelineRunInputFromCandidate,
  canCancelPipelineRun,
  getEffectiveMaxConcurrent,
  getLatestPendingRecoveryReport,
  getPipelineLaunchBlockReason,
  getPipelinePrdTabKey,
  getPipelineRunStatusLabel,
  summarizePipelineRunDetail
} from './pipeline-panel-state'
import type {
  PipelinePrdCandidate,
  PipelineRecoveryReport
} from '../../../../shared/pipelines-types'

describe('pipeline-panel-state', () => {
  it('formats pipeline run statuses for the UI', () => {
    expect(getPipelineRunStatusLabel('planning')).toBe('Planning')
    expect(getPipelineRunStatusLabel('completed')).toBe('Done')
    expect(getPipelineRunStatusLabel('cancelled')).toBe('Cancelled')
  })

  it('allows cancellation only before terminal statuses', () => {
    expect(canCancelPipelineRun('executing')).toBe(true)
    expect(canCancelPipelineRun('completed')).toBe(false)
    expect(canCancelPipelineRun('failed')).toBe(false)
    expect(canCancelPipelineRun('cancelled')).toBe(false)
  })

  it('summarizes run detail counts and errors', () => {
    const detail = {
      run: { error: { message: 'failed' } },
      iterations: [{ error: null }],
      tasks: [{ error: { message: 'task failed' } }, { error: null }],
      stages: [{ error: null }, { error: { message: 'stage failed' } }],
      logs: [{}, {}, {}],
      dynamicContextResults: []
    } as unknown as PipelineRunDetail

    expect(summarizePipelineRunDetail(detail)).toEqual({
      iterations: 1,
      tasks: 2,
      stages: 2,
      logs: 3,
      errors: 3
    })
  })

  it('keys PRD tabs by provider repo and PRD work set, not execution target', () => {
    const candidate = candidateFixture()

    expect(getPipelinePrdTabKey(candidate)).toBe('github:Nikolatesla-lj:orca:13:pipeline:prd-13')
  })

  it('builds GitHub PRD run input and forces sequential concurrency', () => {
    const input = buildPipelineRunInputFromCandidate({
      candidate: candidateFixture(),
      templateId: 'sequential-reviewer',
      repoId: 'repo_orca',
      sourceBranch: 'main',
      targetBranch: 'pipeline-output',
      maxConcurrent: 4,
      maxIterations: 3,
      agentId: 'codex',
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-dev'
    })

    expect(getEffectiveMaxConcurrent('parallel-planner-with-review', 4)).toBe(4)
    expect(input).toMatchObject({
      templateId: 'sequential-reviewer',
      maxConcurrent: 1,
      taskSource: {
        type: 'github_issues',
        owner: 'Nikolatesla-lj',
        repo: 'orca',
        prdIssueNumber: 13,
        pipelinePrdLabel: 'pipeline:prd-13',
        state: 'open'
      },
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-dev'
    })
  })

  it('uses the latest pending recovery report as the launch blocker', () => {
    const candidate = candidateFixture()
    const older = recoveryReportFixture('pipe_recovery_1', '2026-06-05T10:00:00Z')
    const latest = recoveryReportFixture('pipe_recovery_2', '2026-06-05T11:00:00Z')

    expect(getLatestPendingRecoveryReport(candidate, [older, latest])).toBe(latest)
    expect(
      getPipelineLaunchBlockReason({
        candidate,
        latestPendingRecoveryReport: latest
      })
    ).toContain('Acknowledge')
    expect(
      getPipelineLaunchBlockReason({
        candidate: { ...candidate, readyTaskCount: 0 },
        latestPendingRecoveryReport: null
      })
    ).toContain('no open ready')
  })
})

function candidateFixture(): PipelinePrdCandidate {
  return {
    provider: 'github',
    owner: 'Nikolatesla-lj',
    repo: 'orca',
    prdIssueNumber: 13,
    prdTitle: '[PRD] Pipeline v1',
    pipelinePrdLabel: 'pipeline:prd-13',
    readyTaskCount: 1,
    openTaskCount: 2,
    latestTaskUpdatedAt: '2026-06-05T15:00:00Z',
    latestPrdUpdatedAt: '2026-06-05T14:00:00Z'
  }
}

function recoveryReportFixture(id: string, createdAt: string): PipelineRecoveryReport {
  return {
    id,
    interruptedRunId: 'pipe_run_old',
    replacementRunId: null,
    repoId: 'repo_orca',
    providerOwner: 'Nikolatesla-lj',
    providerRepo: 'orca',
    prdIssueNumber: 13,
    pipelinePrdLabel: 'pipeline:prd-13',
    status: 'pending_ack',
    summary: {
      completedTaskIssueNumbers: [],
      openReadyTaskIssueNumbers: [16],
      preservedWorktreeIds: [],
      dirtyWorktreeIds: [],
      liveTerminalIds: [],
      missingTerminalIds: []
    },
    createdAt,
    acknowledgedAt: null
  }
}
