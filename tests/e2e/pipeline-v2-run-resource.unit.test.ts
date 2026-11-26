import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  PipelineRunResource,
  pipelineRunResource
} from '@/components/pipelines/pipeline-run-resource'
import { sendPipelineSessionDiscussion } from '@/components/pipelines/pipeline-session-discussion-send'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { PIPELINE_METHODS } from '../../src/main/runtime/rpc/methods/pipelines/pipelines'
import { PipelineStore } from '../../src/main/runtime/pipelines/pipeline-store'
import { PipelineController } from '../../src/main/runtime/pipelines/pipeline-controller'
import {
  createSessionCallerHarness,
  type SessionCallerHarness
} from '../../src/main/runtime/pipelines/testing/pipeline-session-caller.test-fixture'
import {
  fixtureSession,
  fixtureSource,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from '../../src/main/runtime/pipelines/v2/pipeline-v2.test-fixture'
import {
  createPipelineOwnerActions,
  type PipelineOwnerActions
} from '../../src/main/runtime/pipelines/v2/pipeline-v2-owner-actions'
import { discussPipelineV2BoundSession } from '../../src/main/runtime/pipelines/v2/pipeline-v2-bound-session'
import { synchronizePipelineV2Session } from '../../src/main/runtime/pipelines/v2/pipeline-v2-discussion'
import type { PipelineV2Ports } from '../../src/main/runtime/pipelines/v2/pipeline-v2-execution'
import { PipelineV2OwnerSynchronizeInput } from '../../src/shared/pipelines/v2/pipeline-v2-owner-contracts'
import { observePipelineV2RawInput } from '../../src/main/runtime/pipelines/v2/pipeline-v2-session-input'
import {
  partialRuntimeStore,
  storeRepo
} from '../../src/main/runtime/pipelines/testing/pipeline-runtime-store.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => hostRef.current })
)
const scope = { projectId: 'project-1', workspaceInstanceId: 'instance-1', runId: 'run-1' }
let host: SessionCallerHarness
let store: PipelineStore
let dispatcher: RpcDispatcher
let controller: PipelineController
let owner: PipelineOwnerActions
let bound: Parameters<typeof discussPipelineV2BoundSession>[0]
let resolveDecision: PipelineOwnerActions['resolveDecision']
let synchronize: (
  input: PipelineV2OwnerSynchronizeInput
) => ReturnType<typeof synchronizePipelineV2Session>
beforeEach(() => {
  host = createSessionCallerHarness(hostRef)
  store = new PipelineStore(':memory:')
  const template = gatedV2Template()
  template.limits.maxInvocations = 4
  store.templatesV2.saveDraft({
    projectId: 'project-1',
    requestId: 'save',
    expectedRevision: 0,
    draft: template
  })
  const published = store.templatesV2.publish({
    projectId: 'project-1',
    requestId: 'publish',
    draftId: template.id,
    expectedRevision: 1
  })
  store.createV2({ ...pipelineV2AdmissionFixture(template), definition: published.definition })
  settleV2Stage(store)
  const ports: PipelineV2Ports = {
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => 'b'.repeat(40),
    settled: async () => true,
    checks: async () => {
      throw new Error('Unexpected checks')
    },
    startInvocation: async (request, _spec, prepared) => {
      prepared({ dispatchId: request.invocation.id, session: fixtureSession })
      v2Mutation(store, {
        kind: 'submit',
        invocationId: request.invocation.id,
        dispatchId: request.invocation.id,
        inputRevision: request.invocation.inputRevision,
        sourceRevision: fixtureSource,
        result: {
          status: 'result',
          outcomeId: 'done',
          summary: 'Updated plan with rollback',
          evidence: {
            stage: 'generic',
            statement: 'Rollback explained',
            rationale: 'Owner discussion',
            files: []
          }
        }
      })
      return { state: 'ready', dispatchId: request.invocation.id, session: fixtureSession }
    }
  }
  controller = new PipelineController(
    store,
    {
      ...ports,
      start: async () => {
        throw new Error('Unexpected legacy launch')
      },
      checks: async () => ({ passed: true, body: 'ok' })
    },
    ports
  )
  const service = {
    store,
    getRuntimeId: () => host.runtime.getRuntimeId(),
    controller,
    assertWorkspace: async () => {},
    sourceRevision: ports.sourceRevision,
    reviewCommit: ports.reviewCommit,
    wake: () => {}
  }
  bound = { ...service, v2Ports: ports }
  owner = createPipelineOwnerActions(service)
  resolveDecision = (input) => owner.resolveDecision(input)
  synchronize = (input) => {
    const { expectedRuntimeId, ...request } = PipelineV2OwnerSynchronizeInput.parse(input)
    if (expectedRuntimeId !== host.runtime.getRuntimeId()) {
      throw new Error('pipeline_runtime_identity_changed')
    }
    return synchronizePipelineV2Session(service, request)
  }
  Object.defineProperty(host.runtime, 'pipelineRuntime', { value: bound })
  vi.spyOn(host.runtime, 'getRuntimeId').mockReturnValue('runtime-v2')
  vi.spyOn(host.runtime, 'requireStore').mockReturnValue(
    partialRuntimeStore({
      getRepo: (id: string) => storeRepo({ id, path: '/project', kind: 'git' }),
      getSettings: () => ({})
    })
  )
  dispatcher = new RpcDispatcher({ runtime: host.runtime, methods: PIPELINE_METHODS })
  const windowTarget = new EventTarget()
  Object.assign(windowTarget, {
    api: {
      runtime: {
        call: ({ method, params }: { method: string; params: unknown }) =>
          dispatcher.dispatch({ id: 'renderer', authToken: 'test', method, params }),
        subscribe: async () => ({ unsubscribe: () => {} })
      },
      pipelineOwner: {
        resolveDecision: (input: Parameters<typeof resolveDecision>[0]) => resolveDecision(input),
        resolveBudget: owner.resolveBudget,
        discussBoundSession: (input: unknown) => discussPipelineV2BoundSession(bound, input),
        synchronize: (input: PipelineV2OwnerSynchronizeInput) => synchronize(input)
      }
    }
  })
  vi.stubGlobal('window', windowTarget)
})
afterEach(() => {
  store.close()
  host.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('session and panel share one candidate and reject an old displayed decision after discussion', async () => {
  const session = pipelineRunResource(scope)
  const panel = pipelineRunResource(scope)
  await session.refresh()
  expect(session.snapshot().error).toBeUndefined()
  const shown = session.snapshot().read!
  expect(panel.snapshot().read?.status.run.pendingDecision?.candidateId).toBe(
    shown.status.run.pendingDecision?.candidateId
  )
  session.setText('comment', 'Preserve my comment')
  await sendPipelineSessionDiscussion({
    requestId: 'renderer-discuss',
    sessionId: fixtureSession.sessionId,
    message: 'Explain rollback',
    hasAttachments: false
  })
  await controller.advance('run-1')
  await panel.refresh()
  expect(panel.snapshot().read?.status.run.candidate?.summaryPreview).toBe(
    'Updated plan with rollback'
  )
  await session.act({ kind: 'decide', action: 'accept' }, shown)
  expect(session.snapshot()).toMatchObject({
    comment: 'Preserve my comment',
    actionError: 'pipeline_revision_conflict'
  })
  expect(store.getV2('run-1').stageId).toBe('plan')
  await panel.act({ kind: 'decide', action: 'rework', comment: 'Add a rollback example' })
  expect(store.getV2('run-1').visits.at(-1)?.handoff?.comment).toBe('Add a rollback example')
  expect(session.snapshot().receipt?.candidateId).toBe(
    panel.snapshot().read?.visits[0].decision?.candidateId
  )
})
it('reconciles a lost owner reply and preserves text entered after the submitted comment', async () => {
  const resource = new PipelineRunResource(scope)
  await resource.refresh()
  resource.setText('comment', 'Submitted comment')
  resolveDecision = async (input) => {
    await owner.resolveDecision(input)
    throw new Error('Reply lost')
  }
  const confirmed = await resource.act({
    kind: 'decide',
    action: 'accept',
    comment: 'Submitted comment'
  })
  expect(confirmed).toBe(false)
  expect(resource.snapshot().pending).toBeDefined()
  resource.setText('comment', 'New unsent comment')
  await resource.reconcile()
  expect(resource.snapshot()).toMatchObject({
    comment: 'New unsent comment',
    receipt: { kind: 'decide' }
  })
  expect(resource.snapshot().pending).toBeUndefined()
  expect(store.getV2('run-1').visits.map((visit) => visit.stageId)).toEqual(['plan', 'implement'])
})
it('retains an uncertain synchronization request in the shared resource across card navigation', async () => {
  const resource = new PipelineRunResource(scope)
  observePipelineV2RawInput(store, fixtureSession, {
    receiptId: 'raw-owner-input',
    accepted: true,
    queryReply: false
  })
  await resource.refresh()
  const native = synchronize
  synchronize = async (input) => {
    await native(input)
    throw new Error('Reply lost')
  }
  await resource.synchronize(resource.snapshot().read!)
  const original = resource.snapshot().synchronization?.requestId
  const originalInvocation = store.getV2('run-1').invocations.at(-1)?.id
  expect(original).toBeDefined()
  synchronize = native
  await resource.synchronize(resource.snapshot().read!)
  expect(resource.snapshot().synchronization).toBeUndefined()
  expect(store.receiptV2('run-1', original!)?.requestId).toBe(original)
  expect(store.getV2('run-1').invocations.at(-1)?.id).toBe(originalInvocation)
  expect(store.getV2('run-1').usedInvocations).toBe(2)
})
it('recovers a delivered synchronization after runtime restart through its durable receipt', async () => {
  const resource = new PipelineRunResource(scope)
  await resource.refresh()
  const native = synchronize
  synchronize = async (input) => {
    await native(input)
    throw new Error('Reply lost')
  }
  await resource.synchronize(resource.snapshot().read!)
  const requestId = resource.snapshot().synchronization!.requestId
  vi.mocked(host.runtime.getRuntimeId).mockReturnValue('runtime-restarted')
  await resource.refresh()
  synchronize = async () => {
    throw new Error('Repeated delivery after restart')
  }
  await resource.synchronize(resource.snapshot().read!)
  expect(resource.snapshot().synchronization).toBeUndefined()
  expect(resource.snapshot().actionError).toBeUndefined()
  expect(store.receiptV2('run-1', requestId)?.kind).toBe('reserve')
  expect(store.getV2('run-1').usedInvocations).toBe(2)
})
it('retains an unconfirmed synchronization after restart without dispatching it again', async () => {
  const resource = new PipelineRunResource(scope)
  await resource.refresh()
  synchronize = async () => {
    throw new Error('Connection lost before a reply')
  }
  await resource.synchronize(resource.snapshot().read!)
  const requestId = resource.snapshot().synchronization!.requestId
  vi.mocked(host.runtime.getRuntimeId).mockReturnValue('runtime-restarted')
  await resource.refresh()
  synchronize = async () => {
    throw new Error('Repeated delivery after restart')
  }
  await resource.synchronize(resource.snapshot().read!)
  expect(resource.snapshot().synchronization?.requestId).toBe(requestId)
  expect(resource.snapshot().actionError).toBe('pipeline_synchronization_unconfirmed')
  expect(store.receiptV2('run-1', requestId)).toBeNull()
  expect(store.getV2('run-1').usedInvocations).toBe(1)
})
it('allows owner budget repair after a synchronization was definitely rejected before delivery', async () => {
  const resource = new PipelineRunResource(scope)
  for (const requestId of ['budget-turn-a', 'budget-turn-b', 'budget-turn-c']) {
    await discussPipelineV2BoundSession(bound, {
      requestId,
      sessionId: fixtureSession.sessionId,
      message: 'Explain rollback',
      hasAttachments: false
    })
    await controller.advance('run-1')
  }
  observePipelineV2RawInput(store, fixtureSession, {
    receiptId: 'raw-after-budget',
    accepted: true,
    queryReply: false
  })
  await resource.refresh()
  await resource.synchronize(resource.snapshot().read!)
  expect(resource.snapshot().actionError).toBe('pipeline_budget_exhausted')
  expect(resource.snapshot().synchronization).toBeUndefined()
  expect(await resource.act({ kind: 'extend_budget', extension: { maxInvocations: 5 } })).toBe(true)
  await resource.synchronize(resource.snapshot().read!)
  expect(resource.snapshot().synchronization).toBeUndefined()
  expect(store.getV2('run-1').usedInvocations).toBe(5)
})
it('releases a definitely rejected control so reconciliation can remain available', async () => {
  v2Mutation(store, { kind: 'uncertain', reason: 'pipeline_launch_unconfirmed' })
  const resource = new PipelineRunResource(scope)
  await resource.refresh()
  expect(await resource.act({ kind: 'pause' })).toBe(false)
  expect(resource.snapshot().actionError).toBe('pipeline_not_running')
  expect(resource.snapshot().pending).toBeUndefined()
  expect(store.getV2('run-1').state).toBe('reconciliation_required')
})
it('lets the backend assess source revalidation without requiring a renderer source digest', async () => {
  const resource = new PipelineRunResource(scope)
  await resource.refresh()
  const pin = store.getV2('run-1').pendingDecision
  expect(await resource.act({ kind: 'revalidate' })).toBe(false)
  expect(resource.snapshot().actionError).toBe('pipeline_completion_conflict')
  expect(resource.snapshot().pending).toBeUndefined()
  expect(store.getV2('run-1').pendingDecision).toEqual(pin)
})
it('returns owner-extended budgets and scoped full decision history through the real RPC', async () => {
  const resource = new PipelineRunResource(scope)
  await resource.refresh()
  await resource.act({
    kind: 'extend_budget',
    extension: {
      maxInvocations: 150,
      visitId: 'run-1:visit:1',
      maxDiscussionTurns: 40,
      stageId: 'plan',
      maxReentries: 4
    }
  })
  expect(resource.snapshot().read?.status.run.effectiveLimits).toEqual({
    maxInvocations: 150,
    maxDiscussionTurns: 40,
    maxReentries: 4,
    usedDiscussionTurns: 0,
    usedReentries: 0
  })
  const comment = 'Комментарий с подробностями. '.repeat(30)
  await resource.act({ kind: 'decide', action: 'rework', comment })
  const decision = resource.snapshot().read?.visits[0].decision
  expect(decision).toMatchObject({
    action: 'rework',
    target: { kind: 'stage', stageId: 'plan' },
    commentTruncated: true,
    sessionId: 'primary-session'
  })
  const call = (params: unknown) =>
    dispatcher.dispatch({
      id: 'history-read',
      authToken: 'test',
      method: 'pipeline.v2.context',
      params
    })
  const params = {
    id: 'run-1',
    projectId: 'project-1',
    expectedInstanceId: 'instance-1',
    artifactId: decision!.artifactId
  }
  expect(await call(params)).toMatchObject({
    ok: true,
    result: { artifacts: [{ kind: 'owner_decision', action: 'rework', comment }] }
  })
  expect(await call({ ...params, projectId: 'foreign-project' })).toMatchObject({ ok: false })
  expect(await call({ ...params, visitId: 'run-1:visit:2' })).toMatchObject({ ok: false })
  expect(resource.snapshot().read?.status.run.effectiveLimits).toEqual({
    maxInvocations: 150,
    maxDiscussionTurns: 32,
    maxReentries: 4,
    usedDiscussionTurns: 0,
    usedReentries: 1
  })
})
