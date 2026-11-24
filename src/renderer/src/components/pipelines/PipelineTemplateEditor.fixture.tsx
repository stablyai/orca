import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { PipelineTemplateEditor } from './PipelineTemplateEditor'
import { createPipelineEditorDraft, updatePipelineEditorDraft } from './pipeline-editor-draft'
import type {
  PipelineV2Stage,
  PipelineV2Template
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'

const stages: PipelineV2Stage[] = ['plan', 'implement', 'review'].map((id, index) => ({
  kind: 'agent',
  id,
  title: ['Plan', 'Implementation', 'Review'][index],
  instructions: [
    'Study the task and write a concrete plan. Discuss assumptions before implementation.',
    'Implement the agreed plan and record verification evidence.',
    'Review the result independently. Return to implementation when findings remain.'
  ][index],
  expectedResult: 'An explained result with evidence.',
  evidenceSchema: index === 2 ? 'review' : 'generic',
  independent: index === 2,
  executor: {
    agent: 'codex',
    model: { kind: 'explicit', id: 'fixture-model' },
    effort: 'high',
    surface: 'chat',
    session: { kind: 'fresh' },
    permissionMode: 'own'
  },
  inputs: { task: true, stageIds: index === 0 ? [] : ['plan'] },
  ownerGate: { enabled: index === 0, reworkTargetStageId: index === 2 ? 'implement' : 'plan' },
  maxReentries: 2,
  outcomes: [
    {
      id: 'done',
      title: 'Complete',
      criterion: 'The expected result is complete',
      target: { kind: 'next' }
    },
    ...(index === 2
      ? [
          {
            id: 'changes',
            title: 'Changes requested',
            criterion: 'Important findings remain',
            target: { kind: 'stage' as const, stageId: 'implement' }
          }
        ]
      : [])
  ]
}))
const template: PipelineV2Template = {
  schemaVersion: 2,
  id: 'fixture-template',
  projectId: 'fixture-project',
  version: '1',
  title: 'Development with plan discussion',
  description: 'Plan → implement → review. Discuss the plan in the real agent session.',
  entryStageId: 'plan',
  stages,
  limits: { maxInvocations: 32, maxDiscussionTurns: 8 },
  completionPolicy: { kind: 'workflow_complete' }
}
function Editor({ narrow = false }: { narrow?: boolean }) {
  const [editor, setEditor] = useState(() => createPipelineEditorDraft(template, 1))
  return (
    <div
      className="overflow-y-auto scrollbar-sleek bg-background p-4 text-foreground"
      style={{ height: narrow ? 844 : 1100 }}
    >
      <PipelineTemplateEditor
        editor={editor}
        onEdit={(action) => setEditor((state) => updatePipelineEditorDraft(state, action))}
      />
    </div>
  )
}
function setup() {
  window.api.runtime.call = async ({ method }) => {
    if (method !== 'agentSession.modelCatalog') {
      throw new Error(`Unexpected fixture RPC ${method}`)
    }
    return {
      id: 'fixture',
      ok: true,
      _meta: { runtimeId: 'fixture-runtime' },
      result: {
        origin: 'probe',
        fetchedAt: 0,
        models: [
          {
            id: 'fixture-model',
            label: 'Fixture model',
            isDefault: true,
            efforts: [{ value: 'high', label: 'High' }],
            defaultEffort: 'high'
          }
        ]
      }
    }
  }
}
export const desktop = defineFixture({ width: 1440, setup, render: () => <Editor /> })
export const narrow = defineFixture({ width: 390, setup, render: () => <Editor narrow /> })
