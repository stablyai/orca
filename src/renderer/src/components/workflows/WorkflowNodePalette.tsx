import React from 'react'
import { useReactFlow } from '@xyflow/react'
import type { WorkflowNodeKind } from '../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { addWorkflowNode, workflowNodeKindLabel } from './workflow-editor-mutations'
import { WORKFLOW_NODE_ICONS } from './WorkflowNodeCard'
import { WORKFLOW_NODE_DRAG_TYPE } from './WorkflowCanvas'
import { translate } from '@/i18n/i18n'

const GROUPS: { title: string; kinds: { kind: WorkflowNodeKind; hint: string }[] }[] = [
  {
    title: translate('auto.components.workflows.WorkflowNodePalette.a395139d19', 'Agents'),
    kinds: [
      { kind: 'agent', hint: 'A CLI agent doing one task' },
      { kind: 'coordinator', hint: 'Plans and splits work' },
      { kind: 'reviewer', hint: 'Checks work, returns a verdict' }
    ]
  },
  {
    title: translate('auto.components.workflows.WorkflowNodePalette.18c3085641', 'Flow'),
    kinds: [
      { kind: 'start', hint: 'Run input' },
      { kind: 'parallel', hint: 'Start branches together' },
      { kind: 'join', hint: 'Wait for branches' },
      { kind: 'decision', hint: 'Route on a result' },
      { kind: 'approval', hint: 'Wait for your decision' },
      { kind: 'end', hint: 'Finish and collect' }
    ]
  }
]

export function WorkflowNodePalette(): React.JSX.Element {
  const commit = useWorkflowEditorStore((state) => state.commit)
  const select = useWorkflowEditorStore((state) => state.select)
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const flow = useReactFlow()

  // Keyboard and click users get the same node a drag would place, at the viewport centre.
  const addAtCenter = (kind: WorkflowNodeKind): void => {
    const center = flow.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    })
    let id = ''
    commit((draft) => {
      id = addWorkflowNode(draft, kind, {
        x: Math.round(center.x / 16) * 16,
        y: Math.round(center.y / 16) * 16
      })
    })
    select({ kind: 'nodes', ids: [id] })
  }

  return (
    <nav
      aria-label={translate(
        'auto.components.workflows.WorkflowNodePalette.11caf869bd',
        'Node library'
      )}
      className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-3 scrollbar-sleek"
    >
      {GROUPS.map((group) => (
        <div key={group.title} className="space-y-1">
          <div className="px-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.title}
          </div>
          {group.kinds.map(({ kind, hint }) => {
            const Icon = WORKFLOW_NODE_ICONS[kind]
            return (
              <button
                key={kind}
                type="button"
                draggable={!execution}
                disabled={execution}
                onDragStart={(event) => {
                  event.dataTransfer.setData(WORKFLOW_NODE_DRAG_TYPE, kind)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => addAtCenter(kind)}
                className="flex w-full cursor-grab items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-border hover:bg-accent active:cursor-grabbing disabled:cursor-default disabled:opacity-50"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-4">
                    {workflowNodeKindLabel(kind)}
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">{hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      ))}
      <div className="mt-auto space-y-1.5 rounded-md border border-border p-2.5 text-2xs leading-4 text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">
            {translate(
              'auto.components.workflows.WorkflowNodePalette.a3fc94cba4',
              'Top and bottom ports'
            )}
          </span>{' '}
          {translate(
            'auto.components.workflows.WorkflowNodePalette.96a3eadd08',
            'set execution order.'
          )}
        </p>
        <p>
          <span className="font-medium text-foreground">
            {translate('auto.components.workflows.WorkflowNodePalette.9c3ee56742', 'Side ports')}
          </span>{' '}
          {translate(
            'auto.components.workflows.WorkflowNodePalette.c36f2d2b89',
            'grant a communication route between agents.'
          )}
        </p>
      </div>
    </nav>
  )
}
