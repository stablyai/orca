import { describe, expect, it } from 'vitest'
import { researchPipelineV2Seed } from '../../../../main/runtime/pipelines/v2/pipeline-v2-seeds'
import { createPipelineEditorDraft, updatePipelineEditorDraft } from './pipeline-editor-draft'

describe('pipeline template editing', () => {
  it('resets to the acknowledged snapshot without incorporating edits made during saving', () => {
    let state = createPipelineEditorDraft(researchPipelineV2Seed('project-a'), 3)
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
    const initial = createPipelineEditorDraft(researchPipelineV2Seed('project-a'), 0)
    const edited = updatePipelineEditorDraft(initial, {
      type: 'template',
      patch: { title: 'Changed' }
    })
    const reset = updatePipelineEditorDraft(edited, { type: 'reset' })
    expect(reset.template.title).toBe('Research and synthesis')
    expect(reset.revision).toBe(0)
    expect(reset.dirty).toBe(true)
  })
  it('keeps explicit targets and stage identities when renaming and reordering', () => {
    const state = createPipelineEditorDraft(researchPipelineV2Seed('project-a'), 3)
    const renamed = updatePipelineEditorDraft(state, {
      type: 'stage',
      stage: { ...state.template.stages[0], title: 'Обсуждение плана' }
    })
    const reordered = updatePipelineEditorDraft(renamed, {
      type: 'reorder',
      stageIds: ['research', 'plan', 'result']
    })
    expect(reordered.template.stages.map((stage) => stage.id)).toEqual([
      'research',
      'plan',
      'result'
    ])
    expect(reordered.template.stages[1].title).toBe('Обсуждение плана')
    expect(reordered.template.stages[2].outcomes[1].target).toEqual({
      kind: 'stage',
      stageId: 'research'
    })
    expect(reordered.template.entryStageId).toBe('research')
  })

  it('moves the selected starting stage first while preserving the other stage order', () => {
    const state = createPipelineEditorDraft(researchPipelineV2Seed('project-a'), 3)
    const changed = updatePipelineEditorDraft(state, {
      type: 'template',
      patch: { entryStageId: 'research' }
    })
    expect(changed.template.stages.map((stage) => stage.id)).toEqual(['research', 'plan', 'result'])
    expect(changed.template.entryStageId).toBe('research')
  })

  it('does not apply a late save acknowledgement to another project or newer text', () => {
    const a = updatePipelineEditorDraft(
      createPipelineEditorDraft(researchPipelineV2Seed('project-a'), 3),
      {
        type: 'save-start',
        requestId: 'save-a'
      }
    )
    const b = createPipelineEditorDraft(researchPipelineV2Seed('project-b'), 0)
    const afterLateAck = updatePipelineEditorDraft(b, {
      type: 'save-ack',
      projectId: 'project-a',
      draftId: 'research',
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
      draftId: 'research',
      requestId: 'save-a',
      revision: 4
    })
    expect(acknowledged.template.title).toBe('Новый текст')
    expect(acknowledged.dirty).toBe(true)
    expect(acknowledged.revision).toBe(4)
  })
})
