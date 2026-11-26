import { PipelineV2OwnerRequest } from '../../../../shared/pipelines/v2/pipeline-v2-owner-request-contracts'
import { PipelineV2Receipt } from '../../../../shared/pipelines/v2/pipeline-v2-results'
import { PipelineV2TemplateReceipt } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import type { PipelineV2StatusResult } from '../../../../shared/pipelines/v2/pipeline-v2-public-results'
import { callPipelineRpc } from './pipeline-api'
import type { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type { PipelineV2TemplateShowResult } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'

export type PipelineOwnerProposalRead = {
  request: PipelineV2OwnerRequest | null
  receipt: PipelineV2Receipt | PipelineV2TemplateReceipt | null
  runtimeId: string
}
export async function runPipelineOwnerProposalAction(
  action: () => Promise<void>,
  setBusy: (busy: boolean) => void,
  setError: (error: string) => void
) {
  setBusy(true)
  setError('')
  try {
    await action()
  } catch (error) {
    setError(String(error))
  } finally {
    setBusy(false)
  }
}
function checkedReceipt(request: PipelineV2OwnerRequest, raw: unknown) {
  if (request.kind === 'decision' || request.kind === 'budget') {
    const receipt = PipelineV2Receipt.parse(raw)
    if (
      receipt.requestId !== request.requestId ||
      receipt.runId !== request.input.id ||
      receipt.workspaceInstanceId !== request.input.expectedInstanceId ||
      receipt.inputRevision !== request.input.expectedRevision ||
      receipt.acceptedRevision !== request.input.expectedRevision + 1 ||
      (request.kind === 'decision' &&
        (receipt.candidateId !== request.input.pin.candidateId ||
          receipt.candidateDigest !== request.input.pin.candidateDigest ||
          receipt.sourceRevision !== request.input.pin.sourceRevision)) ||
      receipt.kind !== (request.kind === 'decision' ? 'decide' : 'extend_budget')
    ) {
      throw new Error('pipeline_receipt_conflict')
    }
    return receipt
  }
  const receipt = PipelineV2TemplateReceipt.parse(raw)
  if (
    receipt.requestId !== request.requestId ||
    receipt.selection.projectId !== request.projectId ||
    (request.kind === 'publish'
      ? receipt.action !== 'published' || receipt.selection.id !== request.input.draftId
      : receipt.selection.id !== request.input.id ||
        receipt.selection.version !== request.input.version ||
        receipt.selection.digest !== request.input.digest ||
        receipt.enabled !== request.input.enabled ||
        receipt.action !== (request.input.enabled ? 'enabled' : 'disabled'))
  ) {
    throw new Error('pipeline_template_receipt_conflict')
  }
  return receipt
}

export async function readPipelineOwnerProposal(
  projectId: string,
  kind: PipelineV2OwnerRequest['kind'],
  requestId: string
): Promise<PipelineOwnerProposalRead> {
  const family = kind === 'decision' || kind === 'budget' ? kind : 'template'
  const response = await callPipelineRpc<{ request: unknown; receipt: unknown }>(
    `pipeline.v2.${family}.receipt`,
    { projectId, requestId }
  )
  const request = response.request ? PipelineV2OwnerRequest.parse(response.request) : null
  if (
    request &&
    (request.projectId !== projectId || request.requestId !== requestId || request.kind !== kind)
  ) {
    throw new Error('pipeline_request_conflict')
  }
  return {
    request,
    runtimeId: response.runtimeId,
    receipt: request && response.receipt ? checkedReceipt(request, response.receipt) : null
  }
}

export async function confirmPipelineOwnerProposal(shown: PipelineOwnerProposalRead) {
  const request = PipelineV2OwnerRequest.parse(shown.request)
  if (shown.receipt) {
    return checkedReceipt(request, shown.receipt)
  }
  if (shown.runtimeId !== request.input.expectedRuntimeId) {
    throw new Error('pipeline_runtime_identity_changed')
  }
  const identity = {
    projectId: request.projectId,
    expectedRuntimeId: request.input.expectedRuntimeId
  }
  let receipt: PipelineV2Receipt | PipelineV2TemplateReceipt
  if (request.kind === 'decision' || request.kind === 'budget') {
    const input = request.input
    const current = await callPipelineRpc<PipelineV2StatusResult>('pipeline.v2.status', {
      ...identity,
      id: input.id,
      expectedInstanceId: input.expectedInstanceId
    })
    const command =
      request.kind === 'decision'
        ? {
            kind: 'decide' as const,
            ...request.input.pin,
            action: request.input.action,
            ...(request.input.comment ? { comment: request.input.comment } : {})
          }
        : { kind: 'extend_budget' as const, ...request.input.extension }
    receipt = await window.api.pipelineOwner[
      request.kind === 'decision' ? 'resolveDecision' : 'resolveBudget'
    ]({
      ...identity,
      id: input.id,
      workspaceId: current.run.workspace.id,
      mutation: {
        requestId: request.requestId,
        expectedRevision: input.expectedRevision,
        expectedInstanceId: input.expectedInstanceId,
        command
      }
    })
  } else {
    await callPipelineRpc('pipeline.v2.describe', identity)
    if (request.kind === 'publish') {
      receipt = await window.api.pipelineOwner.publishTemplate({
        requestId: request.requestId,
        projectId: request.projectId,
        draftId: request.input.draftId,
        expectedRevision: request.input.expectedRevision
      })
    } else {
      const { expectedRuntimeId: _runtimeId, ...input } = request.input
      receipt = await window.api.pipelineOwner.disableTemplate(input)
    }
  }
  return checkedReceipt(request, receipt)
}

export type PipelineOwnerProposalDetails = {
  template?: PipelineV2Template
  launchPreview?: PipelineV2TemplateShowResult['launchPreview']
  summary?: string
  target?: string
  subject?: string
  stageTitle?: string
  availability?: 'current' | 'resolved' | 'outdated' | 'runtime_changed'
  recordedStageTitle?: string
}
export async function readPipelineOwnerProposalDetails(
  shown: PipelineOwnerProposalRead
): Promise<PipelineOwnerProposalDetails> {
  const request = PipelineV2OwnerRequest.parse(shown.request)
  const identity = {
    projectId: request.projectId,
    expectedRuntimeId: shown.runtimeId
  }
  const availability = shown.receipt
    ? ('resolved' as const)
    : shown.runtimeId !== request.input.expectedRuntimeId
      ? ('runtime_changed' as const)
      : ('current' as const)
  if (request.kind === 'publish' || request.kind === 'disable') {
    const value = await callPipelineRpc<PipelineV2TemplateShowResult>('pipeline.v2.template.show', {
      ...identity,
      full: true,
      ...(request.kind === 'publish'
        ? shown.receipt && 'selection' in shown.receipt
          ? { selection: shown.receipt.selection }
          : { draftId: request.input.draftId }
        : {
            selection: {
              engineVersion: 2,
              projectId: request.projectId,
              id: request.input.id,
              version: request.input.version,
              digest: request.input.digest
            }
          })
    })
    if (
      !value.record ||
      (!shown.receipt &&
        request.kind === 'publish' &&
        (!('draft' in value.record) || value.record.revision !== request.input.expectedRevision))
    ) {
      if (!shown.receipt) {
        return { availability: availability === 'current' ? 'outdated' : availability }
      }
      throw new Error('pipeline_template_unavailable_or_changed')
    }
    return {
      template: 'draft' in value.record ? value.record.draft : value.record.definition,
      launchPreview: value.launchPreview,
      subject: ('draft' in value.record ? value.record.draft : value.record.definition).title,
      availability
    }
  }
  const current = await callPipelineRpc<PipelineV2StatusResult>('pipeline.v2.status', {
    ...identity,
    id: request.input.id,
    expectedInstanceId: request.input.expectedInstanceId
  })
  const currentAvailability =
    availability === 'current' && current.run.revision !== request.input.expectedRevision
      ? ('outdated' as const)
      : availability
  const shownTemplate = await callPipelineRpc<PipelineV2TemplateShowResult>(
    'pipeline.v2.template.show',
    {
      ...identity,
      full: true,
      selection: {
        engineVersion: 2,
        projectId: request.projectId,
        id: current.run.definition.id,
        version: current.run.definition.version,
        digest: current.run.definitionDigest
      }
    }
  )
  if (!shownTemplate.record || !('definition' in shownTemplate.record)) {
    throw new Error('pipeline_template_unavailable_or_changed')
  }
  const template = shownTemplate.record.definition
  if (request.kind === 'budget') {
    return {
      subject: template.title,
      target: template.stages.find((stage) => stage.id === request.input.extension.stageId)?.title,
      availability: currentAvailability
    }
  }
  const visit = await callPipelineRpc<{ stageId: string }>('pipeline.v2.context', {
    ...identity,
    id: request.input.id,
    expectedInstanceId: request.input.expectedInstanceId,
    visitId: request.input.pin.visitId
  })
  const stage = template.stages.find((stage) => stage.id === visit.stageId)
  if (!stage) {
    throw new Error('pipeline_invalid_target')
  }
  const target =
    request.input.action === 'rework'
      ? stage.ownerGate.reworkTargetStageId
      : request.input.pin.proposedTarget.kind === 'stage'
        ? request.input.pin.proposedTarget.stageId
        : undefined
  const artifact = await callPipelineRpc<{
    runId: string
    artifacts: { id: string; summary?: string }[]
  }>('pipeline.v2.context', {
    ...identity,
    id: request.input.id,
    expectedInstanceId: request.input.expectedInstanceId,
    artifactId: request.input.pin.candidateId
  })
  const candidate = artifact.artifacts.find((value) => value.id === request.input.pin.candidateId)
  if (artifact.runId !== request.input.id || !candidate?.summary) {
    throw new Error('pipeline_candidate_conflict')
  }
  const recordedStageId =
    shown.receipt && 'stageId' in shown.receipt ? shown.receipt.stageId : undefined
  return {
    template,
    summary: candidate.summary,
    subject: template.title,
    stageTitle: stage.title,
    availability: currentAvailability,
    recordedStageTitle: template.stages.find((stage) => stage.id === recordedStageId)?.title,
    target: target
      ? (template.stages.find((stage) => stage.id === target)?.title ?? target)
      : undefined
  }
}
