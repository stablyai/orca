import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type {
  PipelineV2Stage,
  PipelineV2Template
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'

export type PipelineEditorDraft = {
  projectId: string
  template: PipelineV2Template
  baseline: PipelineV2Template
  draftId: string
  revision: number
  editRevision: number
  dirty: boolean
  pending?: { requestId: string; editRevision: number; template: PipelineV2Template }
  saveError?: string
}
export type PipelineEditorAction =
  | { type: 'reset' }
  | { type: 'template'; patch: Partial<Omit<PipelineV2Template, 'projectId' | 'id' | 'stages'>> }
  | { type: 'stage'; stage: PipelineV2Stage }
  | { type: 'insert'; stage: PipelineV2Stage }
  | { type: 'delete'; stageId: string }
  | { type: 'reorder'; stageIds: string[] }
  | { type: 'save-start'; requestId: string }
  | { type: 'save-reject'; requestId: string; reason: string }
  | { type: 'save-ack'; projectId: string; draftId: string; requestId: string; revision: number }

export function createPipelineEditorDraft(
  template: PipelineV2Template,
  revision: number
): PipelineEditorDraft {
  return {
    projectId: template.projectId,
    template,
    baseline: template,
    draftId: template.id,
    revision,
    editRevision: 0,
    dirty: revision === 0
  }
}
export function updatePipelineEditorDraft(
  state: PipelineEditorDraft,
  action: PipelineEditorAction
): PipelineEditorDraft {
  if (action.type === 'reset') {
    return state.pending
      ? state
      : {
          ...state,
          template: state.baseline,
          dirty: state.revision === 0,
          editRevision: state.editRevision + 1,
          saveError: undefined
        }
  }
  if (action.type === 'save-start') {
    return {
      ...state,
      saveError: undefined,
      pending: {
        requestId: action.requestId,
        editRevision: state.editRevision,
        template: state.template
      }
    }
  }
  if (action.type === 'save-reject') {
    return state.pending?.requestId === action.requestId
      ? { ...state, pending: undefined, dirty: true, saveError: action.reason }
      : state
  }
  if (action.type === 'save-ack') {
    if (
      action.projectId !== state.projectId ||
      action.draftId !== state.draftId ||
      action.requestId !== state.pending?.requestId
    ) {
      return state
    }
    return {
      ...state,
      revision: action.revision,
      baseline: state.pending.template,
      dirty: state.editRevision !== state.pending.editRevision,
      pending: undefined
    }
  }
  let template = state.template
  if (action.type === 'template') {
    template = { ...template, ...action.patch }
    if (action.patch.entryStageId) {
      const first = template.stages.find((stage) => stage.id === action.patch.entryStageId)
      if (!first) {
        throw new Error('pipeline_invalid_entry')
      }
      template = {
        ...template,
        stages: [first, ...template.stages.filter((stage) => stage.id !== first.id)]
      }
    }
  } else if (action.type === 'stage') {
    template = {
      ...template,
      stages: template.stages.map((stage) => (stage.id === action.stage.id ? action.stage : stage))
    }
  } else if (action.type === 'insert') {
    if (
      template.stages.length >= 32 ||
      template.stages.some((stage) => stage.id === action.stage.id)
    ) {
      throw new Error('pipeline_stage_limit_or_duplicate')
    }
    template = { ...template, stages: [...template.stages, action.stage] }
  } else if (action.type === 'delete') {
    template = {
      ...template,
      stages: template.stages.filter((stage) => stage.id !== action.stageId),
      ...(template.entryStageId === action.stageId
        ? { entryStageId: template.stages.find((stage) => stage.id !== action.stageId)?.id ?? '' }
        : {})
    }
  } else if (action.type === 'reorder') {
    if (
      action.stageIds.length !== template.stages.length ||
      new Set(action.stageIds).size !== template.stages.length ||
      action.stageIds.some((id) => !template.stages.some((stage) => stage.id === id))
    ) {
      throw new Error('pipeline_invalid_reorder')
    }
    template = {
      ...template,
      entryStageId: action.stageIds[0],
      stages: action.stageIds.map((id) => template.stages.find((stage) => stage.id === id)!)
    }
  }
  return { ...state, template, editRevision: state.editRevision + 1, dirty: true }
}

export function newPipelineStage(kind: PipelineV2Stage['kind']): PipelineV2Stage {
  const id = `stage-${createBrowserUuid()}`
  const common = {
    id,
    title: translate('pipelines.customStage', 'Custom stage'),
    instructions: '',
    expectedResult: 'Describe the expected result.',
    inputs: { task: true, stageIds: [] },
    ownerGate: { enabled: false, reworkTargetStageId: id },
    maxReentries: 2,
    outcomes: [
      {
        id: 'done',
        title: translate('pipelines.doneOutcome', 'Done'),
        criterion: 'The expected result is complete',
        target: { kind: 'next' as const }
      }
    ]
  }
  return kind === 'agent'
    ? {
        ...common,
        kind,
        executor: {
          agent: 'codex',
          model: { kind: 'default' },
          surface: 'chat',
          session: { kind: 'fresh' },
          permissionMode: 'own'
        },
        evidenceSchema: 'generic',
        independent: false
      }
    : {
        ...common,
        kind,
        executor: { checkIds: [] },
        checkOutcomeMap: { passed: 'done', failed: 'failed' },
        outcomes: [
          ...common.outcomes,
          {
            id: 'failed',
            title: translate('pipelines.failedOutcome', 'Failed'),
            criterion: 'A configured check failed',
            target: { kind: 'stage', stageId: id }
          }
        ]
      }
}
export function createCustomPipelineEditorDraft(projectId: string, title: string) {
  const stage = newPipelineStage('agent')
  return createPipelineEditorDraft(
    {
      schemaVersion: 2,
      id: `template-${createBrowserUuid()}`,
      projectId,
      version: '1',
      title,
      description: '',
      entryStageId: stage.id,
      stages: [stage],
      limits: { maxInvocations: 128, maxDiscussionTurns: 32 },
      completionPolicy: { kind: 'workflow_complete' }
    },
    0
  )
}
import { translate } from '@/i18n/i18n'
