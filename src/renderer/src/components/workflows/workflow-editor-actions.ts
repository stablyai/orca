import { useWorkflowEditorStore } from './workflow-editor-store'
import {
  autoLayoutWorkflow,
  copyWorkflowNodes,
  pasteWorkflowNodes,
  removeWorkflowElements
} from './workflow-editor-mutations'

/** Editor commands shared by the toolbar, keyboard shortcuts, and context menus. */
export const workflowEditorActions = {
  deleteSelection(): void {
    const { selection, commit, select, mode } = useWorkflowEditorStore.getState()
    if (!selection || mode === 'execution') {
      return
    }
    commit((draft) =>
      removeWorkflowElements(draft, {
        nodes: selection.kind === 'nodes' ? selection.ids : [],
        dependencies: selection.kind === 'dependency' ? [selection.id] : [],
        communication: selection.kind === 'communication' ? [selection.id] : []
      })
    )
    select(null)
  },
  copySelection(): boolean {
    const { selection, preset, setClipboard } = useWorkflowEditorStore.getState()
    if (!preset || selection?.kind !== 'nodes' || selection.ids.length === 0) {
      return false
    }
    setClipboard({
      data: copyWorkflowNodes(preset, selection.ids),
      definition: structuredClone(preset.definition)
    })
    return true
  },
  paste(): void {
    const { clipboard, commit, select, mode } = useWorkflowEditorStore.getState()
    if (!clipboard || mode === 'execution') {
      return
    }
    let ids: string[] = []
    commit((draft) => {
      ids = pasteWorkflowNodes(draft, clipboard.data, clipboard.definition)
    })
    select({ kind: 'nodes', ids })
  },
  duplicateSelection(): void {
    if (workflowEditorActions.copySelection()) {
      workflowEditorActions.paste()
    }
  },
  selectAll(): void {
    const { preset, select } = useWorkflowEditorStore.getState()
    if (preset) {
      select({ kind: 'nodes', ids: preset.definition.nodes.map((node) => node.id) })
    }
  },
  autoLayout(): void {
    useWorkflowEditorStore.getState().commit(autoLayoutWorkflow)
  },
  toggleRoute(id: string): void {
    useWorkflowEditorStore.getState().commit((draft) => {
      const edge = draft.definition.communication.find((candidate) => candidate.id === id)
      if (edge) {
        edge.enabled = !edge.enabled
      }
    })
  }
}
