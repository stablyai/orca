import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import {
  Bot,
  Flag,
  GitBranch,
  GitFork,
  GitMerge,
  Network,
  Play,
  ScanSearch,
  UserCheck,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  WorkflowNode,
  WorkflowNodeKind
} from '../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { useWorkflowRunViewStore } from './workflow-run-view-store'
import {
  COMM_IN,
  COMM_OUT,
  EXEC_IN,
  EXEC_OUT,
  type WorkflowFlowNode
} from './workflow-flow-mapping'
import { workflowNodeKindLabel } from './workflow-editor-mutations'
import { WORKFLOW_TASK_STATUS_STYLE, workflowNodeRunSummary } from './workflow-status-style'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

export const WORKFLOW_NODE_ICONS: Record<WorkflowNodeKind, LucideIcon> = {
  agent: Bot,
  coordinator: Network,
  reviewer: ScanSearch,
  start: Play,
  end: Flag,
  decision: GitBranch,
  approval: UserCheck,
  parallel: GitFork,
  join: GitMerge
}

function subtitle(node: WorkflowNode): string {
  switch (node.kind) {
    case 'agent':
    case 'coordinator':
    case 'reviewer': {
      const runtime = node.agent.runtime
      return `${runtime.agent} · ${runtime.model ?? 'default model'}`
    }
    case 'decision':
      return 'Routes on a result'
    case 'approval':
      return 'Waits for you'
    case 'join':
      return node.mode === 'all' ? 'Waits for every branch' : 'Continues on the first branch'
    case 'parallel':
      return 'Starts branches together'
    case 'end':
      return node.aggregate ? 'Collects results' : 'Finishes the run'
    case 'start':
      return 'Run input'
  }
}

const HANDLE = '!size-2.5 !border-2 !border-background'

function WorkflowNodeCardImpl({
  id,
  selected,
  data
}: NodeProps<WorkflowFlowNode>): React.JSX.Element | null {
  useUiLanguageRevision()
  // The store shares unchanged node objects across commits, so edits elsewhere keep this reference.
  const node = useWorkflowEditorStore(
    (state) => state.preset?.definition.nodes.find((candidate) => candidate.id === id) ?? null
  )
  const hasError = useWorkflowEditorStore((state) =>
    state.issues.some((issue) => issue.nodeId === id && issue.severity === 'error')
  )
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  // The summary is flat, so a shallow compare keeps polls that change nothing from re-rendering.
  const run = useWorkflowRunViewStore(
    useShallow((state) => (execution && state.run ? workflowNodeRunSummary(state.run, id) : null))
  )
  if (!node) {
    return null
  }
  const Icon = WORKFLOW_NODE_ICONS[node.kind]
  const status = run ? WORKFLOW_TASK_STATUS_STYLE[run.status] : null
  if (!data.hasCommunication) {
    return (
      <div
        data-testid={`workflow-node-${id}`}
        title={subtitle(node)}
        className={cn(
          'relative flex h-11 w-[168px] items-center gap-2 rounded-lg border bg-background px-2.5 shadow-xs transition-[box-shadow,border-color]',
          hasError && !execution ? 'border-destructive/60' : 'border-border',
          status?.frame,
          selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
        )}
      >
        {node.kind !== 'start' ? (
          <Handle
            type="target"
            id={EXEC_IN}
            position={Position.Top}
            className={cn(HANDLE, '!bg-muted-foreground')}
          />
        ) : null}
        {node.kind !== 'end' ? (
          <Handle
            type="source"
            id={EXEC_OUT}
            position={Position.Bottom}
            className={cn(HANDLE, '!bg-muted-foreground')}
          />
        ) : null}
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{node.label}</span>
        {status ? (
          <span
            className={cn('size-1.5 shrink-0 rounded-full', status.dot)}
            aria-label={status.label}
          />
        ) : node.label !== workflowNodeKindLabel(node.kind) ? (
          <span className="shrink-0 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
            {workflowNodeKindLabel(node.kind)}
          </span>
        ) : null}
      </div>
    )
  }
  return (
    <div
      data-testid={`workflow-node-${id}`}
      className={cn(
        'group relative w-[232px] rounded-lg border bg-card text-card-foreground shadow-xs transition-[box-shadow,border-color]',
        hasError && !execution ? 'border-destructive/60' : 'border-border',
        status?.frame,
        selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
      )}
    >
      <Handle
        type="target"
        id={EXEC_IN}
        position={Position.Top}
        className={cn(HANDLE, '!bg-muted-foreground')}
      />
      <Handle
        type="source"
        id={EXEC_OUT}
        position={Position.Bottom}
        className={cn(HANDLE, '!bg-muted-foreground')}
      />
      <Handle
        type="target"
        id={COMM_IN}
        position={Position.Left}
        className={cn(HANDLE, '!rounded-sm !bg-background !border-muted-foreground')}
      />
      <Handle
        type="source"
        id={COMM_OUT}
        position={Position.Right}
        className={cn(HANDLE, '!rounded-sm !bg-background !border-muted-foreground')}
      />
      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
          <Icon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium leading-5">{node.label}</span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {run?.model ? `${run.agent ?? ''} · ${run.model}` : subtitle(node)}
          </div>
        </div>
      </div>
      <div className="flex h-7 items-center gap-2 border-t border-border/70 px-3 text-2xs text-muted-foreground">
        {run && status ? (
          <>
            <span className={cn('size-1.5 shrink-0 rounded-full', status.dot)} aria-hidden />
            <span className={cn('font-medium', status.text)}>{status.label}</span>
            {run.attempt > 1 ? (
              <span>
                {translate('auto.components.workflows.WorkflowNodeCard.014f05dbbb', 'attempt')}
                {run.attempt}
              </span>
            ) : null}
            {run.iteration > 0 ? (
              <span>
                {translate('auto.components.workflows.WorkflowNodeCard.e436bdb0c0', 'rev')}
                {run.iteration + 1}
              </span>
            ) : null}
            <span className="ml-auto tabular-nums">{run.elapsed}</span>
          </>
        ) : (
          <>
            <span className="font-semibold uppercase tracking-wider">
              {workflowNodeKindLabel(node.kind)}
            </span>
            <span className="ml-auto truncate font-mono">{node.id}</span>
          </>
        )}
      </div>
    </div>
  )
}

export const WorkflowNodeCard = React.memo(WorkflowNodeCardImpl)
