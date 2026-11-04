import React from 'react'
import { Copy, LayoutGrid, Maximize, Plus, Power, Trash2 } from 'lucide-react'
import { useReactFlow } from '@xyflow/react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { WORKFLOW_NODE_KINDS } from '../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { addWorkflowNode, workflowNodeKindLabel } from './workflow-editor-mutations'
import { workflowEditorActions } from './workflow-editor-actions'
import { WORKFLOW_NODE_ICONS } from './WorkflowNodeCard'
import { translate } from '@/i18n/i18n'

export type WorkflowContextTarget =
  | { kind: 'pane'; position: { x: number; y: number } }
  | { kind: 'node'; id: string }
  | { kind: 'dependency' | 'communication'; id: string }

export function WorkflowCanvasContextMenu({
  target,
  children
}: {
  target: WorkflowContextTarget
  children: React.ReactNode
}): React.JSX.Element {
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const select = useWorkflowEditorStore((state) => state.select)
  const commit = useWorkflowEditorStore((state) => state.commit)
  const flow = useReactFlow()

  // Right-click acts on what was clicked, so make it the selection first.
  const focusTarget = (): void => {
    if (target.kind === 'node') {
      const current = useWorkflowEditorStore.getState().selection
      if (!(current?.kind === 'nodes' && current.ids.includes(target.id))) {
        select({ kind: 'nodes', ids: [target.id] })
      }
    } else if (target.kind !== 'pane') {
      select({ kind: target.kind, id: target.id })
    }
  }

  return (
    <ContextMenu onOpenChange={(open) => open && focusTarget()}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {target.kind === 'pane' ? (
          <>
            {!execution ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Plus className="size-4" />
                  {translate(
                    'auto.components.workflows.WorkflowCanvasContextMenu.36ae635e26',
                    'Add node'
                  )}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {WORKFLOW_NODE_KINDS.map((kind) => {
                    const Icon = WORKFLOW_NODE_ICONS[kind]
                    return (
                      <ContextMenuItem
                        key={kind}
                        onSelect={() => {
                          let id = ''
                          commit((draft) => {
                            id = addWorkflowNode(draft, kind, target.position)
                          })
                          select({ kind: 'nodes', ids: [id] })
                        }}
                      >
                        <Icon className="size-4" />
                        {workflowNodeKindLabel(kind)}
                      </ContextMenuItem>
                    )
                  })}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : null}
            <ContextMenuItem
              onSelect={() => workflowEditorActions.autoLayout()}
              disabled={execution}
            >
              <LayoutGrid className="size-4" />
              {translate(
                'auto.components.workflows.WorkflowCanvasContextMenu.1e31e9e7e7',
                'Auto-layout'
              )}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void flow.fitView({ padding: 0.2, duration: 200 })}>
              <Maximize className="size-4" />
              {translate(
                'auto.components.workflows.WorkflowCanvasContextMenu.962fc43e78',
                'Fit to view'
              )}
            </ContextMenuItem>
          </>
        ) : null}
        {target.kind === 'node' && !execution ? (
          <>
            <ContextMenuItem onSelect={() => workflowEditorActions.duplicateSelection()}>
              <Copy className="size-4" />
              {translate(
                'auto.components.workflows.WorkflowCanvasContextMenu.d6e87ff6e5',
                'Duplicate'
              )}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => workflowEditorActions.deleteSelection()}
            >
              <Trash2 className="size-4" />
              {translate(
                'auto.components.workflows.WorkflowCanvasContextMenu.8e04f7649d',
                'Delete'
              )}
            </ContextMenuItem>
          </>
        ) : null}
        {(target.kind === 'dependency' || target.kind === 'communication') && !execution ? (
          <>
            {target.kind === 'communication' ? (
              <ContextMenuItem onSelect={() => workflowEditorActions.toggleRoute(target.id)}>
                <Power className="size-4" />
                {translate(
                  'auto.components.workflows.WorkflowCanvasContextMenu.e939cf228c',
                  'Enable or disable route'
                )}
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem
              variant="destructive"
              onSelect={() => workflowEditorActions.deleteSelection()}
            >
              <Trash2 className="size-4" />
              {translate(
                'auto.components.workflows.WorkflowCanvasContextMenu.962f570125',
                'Delete connection'
              )}
            </ContextMenuItem>
          </>
        ) : null}
        {target.kind !== 'pane' && execution ? (
          <ContextMenuItem disabled>
            {translate(
              'auto.components.workflows.WorkflowCanvasContextMenu.41a6c82e9c',
              'Switch to Design to edit'
            )}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
