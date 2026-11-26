import { afterEach, expect, it, vi } from 'vitest'
import { callPipelineRpc } from './pipeline-api'
import { readPipelineOwnerProposalDetails } from './pipeline-owner-proposals'
import { PipelineV2OwnerRequest } from '../../../../shared/pipelines/v2/pipeline-v2-owner-request-contracts'
import { definition, status } from './pipeline-run.fixture-data'

vi.mock('./pipeline-api', () => ({ callPipelineRpc: vi.fn() }))
afterEach(() => vi.clearAllMocks())

it('shows the originally requested stage and candidate when a decision is outdated', async () => {
  const request = PipelineV2OwnerRequest.parse({
    kind: 'decision',
    requestId: 'accept-plan',
    projectId: 'fixture-project',
    createdAt: 0,
    state: 'pending',
    input: {
      id: 'fixture-run',
      projectId: 'fixture-project',
      requestId: 'accept-plan',
      expectedRuntimeId: 'runtime',
      expectedInstanceId: 'fixture-instance',
      expectedRevision: 10,
      pin: status.run.pendingDecision,
      action: 'accept'
    }
  })
  vi.mocked(callPipelineRpc).mockImplementation(async (method, params) => {
    if (method === 'pipeline.v2.status') {
      return { ...status, run: { ...status.run, stageId: 'review' }, runtimeId: 'runtime' }
    }
    if (method === 'pipeline.v2.template.show') {
      return { record: { definition }, runtimeId: 'runtime' }
    }
    if (params && typeof params === 'object' && 'visitId' in params) {
      return { stageId: 'plan', runtimeId: 'runtime' }
    }
    if (params && typeof params === 'object' && 'artifactId' in params) {
      return {
        runId: 'fixture-run',
        artifacts: [{ id: 'candidate-current', summary: 'Original plan result' }],
        runtimeId: 'runtime'
      }
    }
    throw new Error('Unexpected read')
  })
  const detail = await readPipelineOwnerProposalDetails({
    request,
    receipt: null,
    runtimeId: 'runtime'
  })
  expect(detail).toMatchObject({
    availability: 'outdated',
    stageTitle: 'Изучение задачи и план',
    target: 'Реализация',
    summary: 'Original plan result'
  })
})

it('reads a confirmed publication from its immutable version after the runtime restarted', async () => {
  const request = PipelineV2OwnerRequest.parse({
    kind: 'publish',
    requestId: 'publish-template',
    projectId: 'fixture-project',
    createdAt: 0,
    state: 'pending',
    input: {
      projectId: 'fixture-project',
      draftId: definition.id,
      requestId: 'publish-template',
      expectedRuntimeId: 'previous-runtime',
      expectedRevision: 5
    }
  })
  const selection = {
    engineVersion: 2 as const,
    projectId: 'fixture-project',
    id: definition.id,
    version: definition.version,
    digest: definition.digest
  }
  vi.mocked(callPipelineRpc).mockImplementation(async (method, params) => {
    expect(method).toBe('pipeline.v2.template.show')
    expect(params).toEqual({
      projectId: 'fixture-project',
      expectedRuntimeId: 'current-runtime',
      full: true,
      selection
    })
    return { record: { definition }, runtimeId: 'current-runtime' }
  })
  const detail = await readPipelineOwnerProposalDetails({
    request,
    receipt: { requestId: 'publish-template', selection, action: 'published', enabled: true },
    runtimeId: 'current-runtime'
  })
  expect(detail).toMatchObject({
    availability: 'resolved',
    subject: 'Разработка с обсуждением плана'
  })
})
