import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PipelineStore } from '../../src/main/runtime/pipelines/pipeline-store'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  fixtureSource
} from '../../src/main/runtime/pipelines/v2/pipeline-v2.test-fixture'
import { createPipelineOwnerActions } from '../../src/main/runtime/pipelines/v2/pipeline-v2-owner-actions'
import { createPipelineTemplateOwnerActions } from '../../src/main/runtime/pipelines/v2/pipeline-v2-template-owner-actions'
import { pipelineV2Summary } from '../../src/main/runtime/rpc/methods/pipelines/pipeline-v2-scope'
import { confirmPipelineOwnerProposal } from '../../src/renderer/src/components/pipelines/pipeline-owner-proposals'
import type { PipelineV2OwnerRequest } from '../../src/shared/pipelines/v2/pipeline-v2-owner-request-contracts'

let store: PipelineStore
const runtimeId = 'proposal-runtime'
beforeEach(() => {
  store = new PipelineStore(':memory:')
  const template = gatedV2Template()
  store.templatesV2.saveDraft({
    projectId: 'project-1',
    requestId: 'draft',
    expectedRevision: 0,
    draft: template
  })
  const version = store.templatesV2.publish({
    requestId: 'initial-publish',
    projectId: 'project-1',
    draftId: template.id,
    expectedRevision: 1
  })
  store.createV2({ ...pipelineV2AdmissionFixture(template), definition: version.definition })
  settleV2Stage(store)
  const owner = createPipelineOwnerActions({
    store,
    getRuntimeId: () => runtimeId,
    assertWorkspace: async () => {},
    sourceRevision: async () => fixtureSource,
    wake: () => {}
  })
  const library = createPipelineTemplateOwnerActions({
    store,
    assertProject: async () => {},
    wake: () => {}
  })
  vi.stubGlobal('window', {
    api: {
      pipelineOwner: { ...owner, ...library },
      runtime: {
        call: async ({
          method,
          params
        }: {
          method: string
          params: { expectedRuntimeId: string }
        }) => {
          if (params.expectedRuntimeId !== runtimeId) {
            throw new Error('pipeline_runtime_identity_changed')
          }
          return {
            ok: true,
            result:
              method === 'pipeline.v2.status'
                ? { run: pipelineV2Summary(store.getV2('run-1')) }
                : { version: 2 },
            _meta: { runtimeId }
          }
        }
      }
    }
  })
})
afterEach(() => {
  store.close()
  vi.unstubAllGlobals()
})
function proposal(kind: PipelineV2OwnerRequest['kind']) {
  const run = store.getV2('run-1')
  const identity = {
    requestId: `owner-${kind}`,
    projectId: 'project-1',
    expectedRuntimeId: runtimeId
  }
  const control = {
    ...identity,
    id: run.id,
    expectedRevision: run.revision,
    expectedInstanceId: run.workspace.instanceId
  }
  const input =
    kind === 'decision'
      ? { ...control, pin: run.pendingDecision, action: 'accept' }
      : kind === 'budget'
        ? { ...control, extension: { maxInvocations: 129 } }
        : kind === 'publish'
          ? { ...identity, draftId: run.definition.id, expectedRevision: 1 }
          : {
              ...identity,
              engineVersion: 2,
              id: run.definition.id,
              version: run.definition.version,
              digest: run.definitionDigest,
              enabled: false
            }
  const request = store.ownerRequestsV2.request(kind, input)
  return { request, run, identity }
}
it.each(['decision', 'budget', 'publish', 'disable'] as const)(
  'confirms a %s proposal with its original identity through native owner actions',
  async (kind) => {
    const { request, run, identity } = proposal(kind)
    const shown = { request, receipt: null, runtimeId }
    const receipt = await confirmPipelineOwnerProposal(shown)
    expect(receipt).toMatchObject({ requestId: identity.requestId })
    expect(await confirmPipelineOwnerProposal(shown)).toEqual(receipt)
    expect(
      kind === 'decision' || kind === 'budget'
        ? store.receiptV2(run.id, identity.requestId)
        : store.templatesV2.receipt('project-1', identity.requestId)
    ).toMatchObject({ requestId: identity.requestId })
    expect(
      store.ownerRequestsV2
        .list('project-1')
        .requests.find((row) => row.requestId === request.requestId)?.state
    ).toBe('resolved')
  }
)
it('rejects a receipt for a different decision candidate', async () => {
  const { request } = proposal('decision')
  const receipt = await confirmPipelineOwnerProposal({ request, receipt: null, runtimeId })
  if (!('candidateDigest' in receipt)) {
    throw new Error('Expected decision receipt')
  }
  await expect(
    confirmPipelineOwnerProposal({
      request,
      receipt: { ...receipt, candidateDigest: 'f'.repeat(64) },
      runtimeId
    })
  ).rejects.toThrow('pipeline_receipt_conflict')
})
it('refuses an old-runtime proposal without changing its original identity or the run', async () => {
  const { request, run } = proposal('decision')
  await expect(
    confirmPipelineOwnerProposal({ request, receipt: null, runtimeId: 'restarted-runtime' })
  ).rejects.toThrow('pipeline_runtime_identity_changed')
  expect(store.getV2(run.id)).toEqual(run)
})
it.each(['decision', 'budget', 'publish', 'disable'] as const)(
  'refuses changing the original %s intent under the same proposal identity',
  async (kind) => {
    const { request, run } = proposal(kind)
    const changed =
      request.kind === 'decision'
        ? { ...request, input: { ...request.input, comment: 'Altered owner comment' } }
        : request.kind === 'budget'
          ? { ...request, input: { ...request.input, extension: { maxInvocations: 130 } } }
          : request.kind === 'publish'
            ? { ...request, input: { ...request.input, expectedRevision: 2 } }
            : { ...request, input: { ...request.input, enabled: true } }
    await expect(
      confirmPipelineOwnerProposal({ request: changed, receipt: null, runtimeId })
    ).rejects.toThrow('pipeline_request_conflict')
    expect(store.getV2(run.id).revision).toBe(run.revision)
  }
)
