import { compilePipelineV2 } from '../../../../shared/pipelines/v2/pipeline-v2-compiler'
import { PipelineV2StatusResult } from '../../../../shared/pipelines/v2/pipeline-v2-public-results'
import type { PipelineWorkspace } from './use-pipeline-workspace'

export const definition = compilePipelineV2({
  schemaVersion: 2,
  id: 'fixture-development',
  projectId: 'fixture-project',
  version: '1',
  title: 'Разработка с обсуждением плана',
  description: '',
  entryStageId: 'plan',
  stages: ['plan', 'implement', 'review'].map((id, index) => ({
    id,
    title: ['Изучение задачи и план', 'Реализация', 'Ревью'][index],
    kind: 'agent',
    instructions: 'Выполнить этап и обосновать результат.',
    expectedResult: 'Результат с подтверждениями.',
    executor: {
      agent: 'codex',
      model: { kind: 'explicit', id: 'gpt-6.1-sol' },
      effort: 'high',
      surface: 'chat',
      session: { kind: 'fresh' },
      permissionMode: 'own'
    },
    evidenceSchema: 'generic',
    independent: false,
    inputs: { task: true, stageIds: [] },
    ownerGate: { enabled: index === 0, reworkTargetStageId: id },
    maxReentries: 2,
    outcomes: [
      {
        id: 'done',
        title: 'Готово',
        criterion: 'Результат готов',
        target: index === 2 ? { kind: 'finish' } : { kind: 'next' }
      }
    ]
  })),
  limits: { maxInvocations: 32, maxDiscussionTurns: 8 },
  completionPolicy: { kind: 'workflow_complete' }
})
export const workspace: PipelineWorkspace = {
  id: 'fixture-workspace',
  repoId: 'fixture-project',
  instanceId: 'fixture-instance',
  path: '/project/cart-discount',
  head: 'abc123',
  branch: 'cart-discount',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Скидки в корзине',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  pipeline: {
    engineVersion: 2,
    projectId: 'fixture-project',
    runId: 'fixture-run',
    profileId: definition.id,
    version: definition.version,
    digest: definition.digest
  }
}
const source = 'a'.repeat(64)
const executor = {
  agent: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  surface: 'chat',
  permissionMode: 'own',
  compatibilityKey: 'c'.repeat(64)
}
const session = {
  kind: 'structured',
  sessionId: 'fixture-session',
  compatibilityKey: 'c'.repeat(64)
}
export const fixtureSummary =
  'План обновлён после обсуждения:\n1. Сохранить текущий API корзины.\n2. Добавить расчёт скидки и тесты граничных сумм.\n3. Проверить повторное применение и описать откат.'
export const status = PipelineV2StatusResult.parse({
  contractVersion: 2,
  sourceRevision: source,
  sourceAvailable: true,
  workflowComplete: false,
  ready: false,
  currentEvidence: false,
  run: {
    id: 'fixture-run',
    engineVersion: 2,
    workspace: {
      id: workspace.id,
      instanceId: workspace.instanceId,
      projectId: workspace.repoId,
      hostId: 'local'
    },
    revision: 12,
    eventSequence: 13,
    state: 'waiting_owner',
    stageId: 'plan',
    currentVisitId: 'visit-current',
    definitionDigest: definition.digest,
    definitionEnabled: true,
    sourceRevision: source,
    waitReason: 'owner_gate',
    pendingDecision: {
      id: 'decision-current',
      visitId: 'visit-current',
      candidateId: 'candidate-current',
      candidateDigest: 'b'.repeat(64),
      sourceRevision: source,
      discussionRevision: 1,
      proposedOutcomeId: 'done',
      proposedTarget: { kind: 'stage', stageId: 'implement' }
    },
    usedInvocations: 3,
    visitCount: 2,
    candidateCount: 3,
    definition: {
      id: definition.id,
      title: definition.title,
      version: definition.version,
      completionPolicy: definition.completionPolicy,
      limits: definition.limits,
      stageCount: 3,
      stagesTruncated: false,
      stages: definition.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        kind: stage.kind,
        maxReentries: stage.maxReentries,
        ownerGate: stage.ownerGate.enabled
      }))
    },
    currentInvocation: {
      id: 'discussion-current',
      visitId: 'visit-current',
      stageId: 'plan',
      purpose: 'discussion',
      state: 'settled',
      inputRevision: 9,
      sourceRevision: source,
      discussionRevision: 1,
      dispatchId: 'dispatch-current',
      session,
      candidateId: 'candidate-current'
    },
    currentExecutor: executor,
    effectiveLimits: {
      maxInvocations: 32,
      maxDiscussionTurns: 8,
      maxReentries: 2,
      usedDiscussionTurns: 1,
      usedReentries: 1
    },
    candidate: {
      id: 'candidate-current',
      digest: 'b'.repeat(64),
      summaryPreview: fixtureSummary,
      summaryTruncated: false,
      sessionId: 'fixture-session'
    }
  }
})
export const visits = [
  {
    id: 'visit-previous',
    stageId: 'plan',
    attempt: 0,
    state: 'completed',
    discussionTurns: 0,
    candidateCount: 1,
    hasOwnerComment: false,
    latestCandidateId: 'candidate-previous',
    executor,
    session,
    decision: {
      artifactId: 'owner-decision-previous',
      action: 'rework',
      target: { kind: 'stage', stageId: 'plan' },
      candidateId: 'candidate-previous',
      sessionId: 'fixture-session',
      sourceRevision: source,
      commentPreview: 'Добавить в план тест повторного применения скидки и описание отката.',
      commentTruncated: false
    }
  },
  {
    id: 'visit-current',
    stageId: 'plan',
    attempt: 1,
    state: 'waiting_owner',
    discussionTurns: 1,
    candidateCount: 2,
    hasOwnerComment: true,
    latestCandidateId: 'candidate-current',
    executor,
    session
  }
]
