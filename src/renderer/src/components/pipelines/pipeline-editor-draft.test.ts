import { describe, expect, it } from 'vitest'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { createPipelineEditorDraft, updatePipelineEditorDraft } from './pipeline-editor-draft'

describe('pipeline template editing', () => {
  it('resets to the acknowledged snapshot without incorporating edits made during saving', () => {
    let state = createPipelineEditorDraft(pipelineV2TemplateFixture('project-a'), 3)
    state = updatePipelineEditorDraft(state, { type: 'template', patch: { title: 'Saved title' } })
    state = updatePipelineEditorDraft(state, { type: 'save-start', requestId: 'save-a' })
    state = updatePipelineEditorDraft(state, { type: 'template', patch: { title: 'Later edit' } })
    expect(updatePipelineEditorDraft(state, { type: 'reset' }).template.title).toBe('Later edit')
    state = updatePipelineEditorDraft(state, {
      type: 'save-ack',
      projectId: 'project-a',
      draftId: state.draftId,
      requestId: 'save-a',
      revision: 4
    })
    state = updatePipelineEditorDraft(state, { type: 'reset' })
    expect(state.template.title).toBe('Saved title')
    expect(state.dirty).toBe(false)
    expect(state.revision).toBe(4)
  })
  it('restores a new local draft to its starting point while leaving it unsaved', () => {
    const initial = createPipelineEditorDraft(
      { ...pipelineV2TemplateFixture('project-a'), title: 'Initial draft' },
      0
    )
    const edited = updatePipelineEditorDraft(initial, {
      type: 'template',
      patch: { title: 'Changed' }
    })
    const reset = updatePipelineEditorDraft(edited, { type: 'reset' })
    expect(reset.template.title).toBe('Initial draft')
    expect(reset.revision).toBe(0)
    expect(reset.dirty).toBe(true)
  })
  it('keeps explicit targets and stage identities when renaming and reordering', () => {
    const state = createPipelineEditorDraft(pipelineV2TemplateFixture('project-a'), 3)
    const renamed = updatePipelineEditorDraft(state, {
      type: 'stage',
      stage: { ...state.template.stages[0], title: 'Обсуждение плана' }
    })
    const reordered = updatePipelineEditorDraft(renamed, {
      type: 'reorder',
      stageIds: ['implement', 'plan', 'review']
    })
    expect(reordered.template.stages.map((stage) => stage.id)).toEqual([
      'implement',
      'plan',
      'review'
    ])
    expect(reordered.template.stages[1].title).toBe('Обсуждение плана')
    expect(reordered.template.stages[2].outcomes[1].target).toEqual({
      kind: 'stage',
      stageId: 'plan'
    })
    expect(reordered.template.entryStageId).toBe('implement')
  })

  it('moves the selected starting stage first while preserving the other stage order', () => {
    const state = createPipelineEditorDraft(pipelineV2TemplateFixture('project-a'), 3)
    const changed = updatePipelineEditorDraft(state, {
      type: 'template',
      patch: { entryStageId: 'implement' }
    })
    expect(changed.template.stages.map((stage) => stage.id)).toEqual([
      'implement',
      'plan',
      'review'
    ])
    expect(changed.template.entryStageId).toBe('implement')
  })

  it('does not apply a late save acknowledgement to another project or newer text', () => {
    const a = updatePipelineEditorDraft(
      createPipelineEditorDraft(pipelineV2TemplateFixture('project-a'), 3),
      {
        type: 'save-start',
        requestId: 'save-a'
      }
    )
    const b = createPipelineEditorDraft(pipelineV2TemplateFixture('project-b'), 0)
    const afterLateAck = updatePipelineEditorDraft(b, {
      type: 'save-ack',
      projectId: 'project-a',
      draftId: 'development',
      requestId: 'save-a',
      revision: 4
    })
    expect(afterLateAck.projectId).toBe('project-b')
    expect(afterLateAck.revision).toBe(0)
    const edited = updatePipelineEditorDraft(a, {
      type: 'template',
      patch: { title: 'Новый текст' }
    })
    const acknowledged = updatePipelineEditorDraft(edited, {
      type: 'save-ack',
      projectId: 'project-a',
      draftId: 'development',
      requestId: 'save-a',
      revision: 4
    })
    expect(acknowledged.template.title).toBe('Новый текст')
    expect(acknowledged.dirty).toBe(true)
    expect(acknowledged.revision).toBe(4)
  })
})
