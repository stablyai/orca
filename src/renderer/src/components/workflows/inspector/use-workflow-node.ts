import { useCallback } from 'react'
import {
  isWorkflowAgentNode,
  type WorkflowAgentNode,
  type WorkflowAgentProfile,
  type WorkflowNode
} from '../../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from '../workflow-editor-store'

export function useWorkflowNode(id: string): WorkflowNode | null {
  return useWorkflowEditorStore(
    (state) => state.preset?.definition.nodes.find((node) => node.id === id) ?? null
  )
}

/** Field edits commit without history; the field's focus checkpoint makes the whole edit one undo step. */
export function useUpdateWorkflowNode(id: string): (mutate: (node: WorkflowNode) => void) => void {
  const commit = useWorkflowEditorStore((state) => state.commit)
  return useCallback(
    (mutate) =>
      commit(
        (draft) => {
          const node = draft.definition.nodes.find((candidate) => candidate.id === id)
          if (node) {
            mutate(node)
          }
        },
        { history: false }
      ),
    [commit, id]
  )
}

export function useUpdateAgentProfile(
  id: string
): (mutate: (agent: WorkflowAgentProfile, node: WorkflowAgentNode) => void) => void {
  const update = useUpdateWorkflowNode(id)
  return useCallback(
    (mutate) =>
      update((node) => {
        if (isWorkflowAgentNode(node)) {
          mutate(node.agent, node)
        }
      }),
    [update]
  )
}
