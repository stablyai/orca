import { beforeEach, describe, expect, it } from 'vitest'
import { authenticationFeatureTemplate } from '../../../../shared/workflow/workflow-templates-team'
import { isWorkflowDraftDirty, useWorkflowEditorStore } from './workflow-editor-store'

describe('workflow editor dirty state', () => {
  beforeEach(() => {
    useWorkflowEditorStore.getState().load(authenticationFeatureTemplate(), { saved: true })
  })

  it('stays clean when only the viewport moves, as fit-to-view does on open', () => {
    useWorkflowEditorStore.getState().commit(
      (draft) => {
        draft.layout.viewport = { x: -120, y: 40, zoom: 0.7 }
      },
      { history: false }
    )
    expect(isWorkflowDraftDirty(useWorkflowEditorStore.getState())).toBe(false)
  })

  it('turns dirty on a real edit and clean again after undo', () => {
    useWorkflowEditorStore.getState().commit((draft) => {
      draft.definition.nodes[1].label = 'Planner'
    })
    expect(isWorkflowDraftDirty(useWorkflowEditorStore.getState())).toBe(true)
    useWorkflowEditorStore.getState().undo()
    expect(isWorkflowDraftDirty(useWorkflowEditorStore.getState())).toBe(false)
  })
})
