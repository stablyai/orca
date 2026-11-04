import React from 'react'
import { Check, RotateCcw, SquareTerminal, X } from 'lucide-react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  WorkflowDispatch,
  WorkflowRun
} from '../../../../../shared/workflow/workflow-run-types'
import { WORKFLOW_TASK_STATUS_STYLE, formatWorkflowDuration } from '../workflow-status-style'
import { workflowRunActions } from '../workflow-run-actions'
import { useWorkflowClock } from '../use-workflow-clock'
import { InspectorNote, InspectorSection } from './workflow-inspector-fields'
import { WorkflowPromptSections } from './AgentPromptSection'
import { translate } from '@/i18n/i18n'

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right', mono && 'font-mono text-2xs')}>
        {value ?? '—'}
      </span>
    </div>
  )
}

function revealWorker(dispatch: WorkflowDispatch, run: WorkflowRun): boolean {
  const pane = dispatch.orcaPaneKey ? parsePaneKey(dispatch.orcaPaneKey) : null
  const worktreeId = dispatch.orcaWorktreeId ?? run.placement.worktreeSelector.replace(/^id:/, '')
  return pane
    ? revealTerminalPane({
        worktreeId,
        tabId: pane.tabId,
        leafId: pane.leafId,
        executionHostId: null
      })
    : false
}

function DispatchCard({ dispatch, run }: { dispatch: WorkflowDispatch; run: WorkflowRun }) {
  const now = useWorkflowClock()
  const modelChanged =
    dispatch.effective &&
    dispatch.requested &&
    dispatch.effective.model !== dispatch.requested.model
  return (
    <div className="space-y-1.5 rounded-md border border-border px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          {translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.ab375d258e',
            'Attempt'
          )}{' '}
          {dispatch.attempt}
        </span>
        <span className="text-2xs text-muted-foreground">{dispatch.state}</span>
      </div>
      <Row
        label={translate(
          'auto.components.workflows.inspector.NodeExecutionInspector.1238d8e3b6',
          'Dispatch'
        )}
        value={dispatch.orcaDispatchId}
        mono
      />
      <Row
        label={translate(
          'auto.components.workflows.inspector.NodeExecutionInspector.c75f9c4e76',
          'Terminal'
        )}
        value={dispatch.orcaTerminalHandle}
        mono
      />
      <Row
        label={translate(
          'auto.components.workflows.inspector.NodeExecutionInspector.9262e9d824',
          'Requested'
        )}
        value={
          dispatch.requested
            ? `${dispatch.requested.agent} · ${dispatch.requested.model ?? 'default'}${dispatch.requested.effort ? ` · ${dispatch.requested.effort}` : ''}`
            : null
        }
      />
      <Row
        label={translate(
          'auto.components.workflows.inspector.NodeExecutionInspector.3ff2e411f9',
          'Effective'
        )}
        value={
          dispatch.effective
            ? `${dispatch.effective.agent ?? '?'} · ${dispatch.effective.model ?? 'agent default'}`
            : 'not confirmed'
        }
      />
      {modelChanged ? (
        <InspectorNote tone="warning">
          {translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.015d7b6046',
            'The launched model differs from the requested one (fallback allowed).'
          )}
        </InspectorNote>
      ) : null}
      <Row
        label={translate(
          'auto.components.workflows.inspector.NodeExecutionInspector.8e7c6ee87c',
          'Duration'
        )}
        value={formatWorkflowDuration(
          dispatch.settledAt
            ? Date.parse(dispatch.settledAt) - Date.parse(dispatch.startedAt)
            : now - Date.parse(dispatch.startedAt)
        )}
      />
      {dispatch.error ? <InspectorNote tone="error">{dispatch.error}</InspectorNote> : null}
      {dispatch.orcaPaneKey ? (
        <Button variant="outline" size="xs" onClick={() => revealWorker(dispatch, run)}>
          <SquareTerminal />
          {translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.a7a1d42443',
            'Open terminal'
          )}
        </Button>
      ) : null}
    </div>
  )
}

export function NodeExecutionInspector({
  run,
  nodeId
}: {
  run: WorkflowRun
  nodeId: string
}): React.JSX.Element {
  const node = run.definition.nodes.find((candidate) => candidate.id === nodeId)
  const tasks = Object.values(run.tasks)
    .filter((task) => task.nodeId === nodeId)
    .sort((a, b) => b.iteration - a.iteration)
  const task = tasks[0]
  const style = task ? WORKFLOW_TASK_STATUS_STYLE[task.status] : null
  const confirm = useConfirmationDialog()
  const retryable =
    task && (task.status === 'failed' || task.status === 'unknown' || task.status === 'cancelled')
  // A worker can end its turn on an error without reporting; it still holds the Dispatch.
  const stoppable = task?.status === 'running'
  const messages = run.messages.filter(
    (message) => message.sourceNodeId === nodeId || message.destinationNodeId === nodeId
  )
  return (
    <>
      <InspectorSection title={node?.label ?? nodeId}>
        <div className="flex items-center gap-2 text-[13px]">
          <span className={cn('size-2 rounded-full', style?.dot)} aria-hidden />
          <span className={cn('font-medium', style?.text)}>
            {style?.label ??
              translate(
                'auto.components.workflows.inspector.NodeExecutionInspector.90a17179ca',
                'Not in this run'
              )}
          </span>
          {task && task.iteration > 0 ? (
            <span className="text-xs text-muted-foreground">
              {translate(
                'auto.components.workflows.inspector.NodeExecutionInspector.9e914c24a1',
                'revision'
              )}{' '}
              {task.iteration + 1}
            </span>
          ) : null}
        </div>
        <Row
          label={translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.5398411bd5',
            'Orca task'
          )}
          value={task?.orcaTaskId}
          mono
        />
        <Row
          label={translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.7625474403',
            'Waited'
          )}
          value={formatWorkflowDuration(
            task?.readyAt && task.startedAt
              ? Date.parse(task.startedAt) - Date.parse(task.readyAt)
              : null
          )}
        />
        <Row
          label={translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.3fdea816bf',
            'Messages'
          )}
          value={messages.length}
        />
        {task?.error ? <InspectorNote tone="error">{task.error}</InspectorNote> : null}
        <div className="flex flex-wrap gap-2">
          {retryable ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void workflowRunActions.retry(task.key)}
            >
              <RotateCcw />
              {translate(
                'auto.components.workflows.inspector.NodeExecutionInspector.86da9e5cfc',
                'Retry task'
              )}
            </Button>
          ) : null}
          {stoppable ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void confirm({
                  title: translate(
                    'auto.components.workflows.inspector.NodeExecutionInspector.stopRetryTitle',
                    'Stop this worker and retry?'
                  ),
                  description: translate(
                    'auto.components.workflows.inspector.NodeExecutionInspector.stopRetryBody',
                    'Orca stops the worker, then starts a new attempt only if the stop is proven.'
                  ),
                  confirmLabel: translate(
                    'auto.components.workflows.inspector.NodeExecutionInspector.stopRetryConfirm',
                    'Stop and retry'
                  ),
                  confirmVariant: 'destructive'
                }).then((accepted) => {
                  if (accepted) {
                    void workflowRunActions.retry(task.key)
                  }
                })
              }
            >
              <RotateCcw />
              {translate(
                'auto.components.workflows.inspector.NodeExecutionInspector.stopRetry',
                'Stop and retry'
              )}
            </Button>
          ) : null}
          {task?.status === 'awaiting-approval' ? (
            <>
              <Button
                size="sm"
                onClick={() => void workflowRunActions.resolveApproval(task.key, 'approved')}
              >
                <Check />
                {translate(
                  'auto.components.workflows.inspector.NodeExecutionInspector.652cf02a10',
                  'Approve'
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void workflowRunActions.resolveApproval(task.key, 'rejected')}
              >
                <X />
                {translate(
                  'auto.components.workflows.inspector.NodeExecutionInspector.1502e6f461',
                  'Reject'
                )}
              </Button>
            </>
          ) : null}
        </div>
      </InspectorSection>
      {task?.report ? (
        <InspectorSection
          title={translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.92c8585731',
            'Report'
          )}
        >
          <p className="text-xs font-medium">{task.report.subject}</p>
          <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
            {task.report.summary ||
              translate(
                'auto.components.workflows.inspector.NodeExecutionInspector.ae14a00afa',
                'No summary.'
              )}
          </p>
          {Object.keys(task.report.data).length > 0 ? (
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs scrollbar-sleek">
              {JSON.stringify(task.report.data, null, 2)}
            </pre>
          ) : null}
          {task.report.dataError ? (
            <InspectorNote tone="warning">{task.report.dataError}</InspectorNote>
          ) : null}
          {task.report.filesModified.length > 0 ? (
            <Row
              label={translate(
                'auto.components.workflows.inspector.NodeExecutionInspector.b6f6ebdc16',
                'Files'
              )}
              value={task.report.filesModified.join(', ')}
              mono
            />
          ) : null}
        </InspectorSection>
      ) : null}
      {task && task.dispatches.length > 0 ? (
        <InspectorSection
          title={translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.282d717069',
            'Attempts'
          )}
        >
          {task.dispatches.toReversed().map((dispatch) => (
            <DispatchCard key={dispatch.requestId} dispatch={dispatch} run={run} />
          ))}
        </InspectorSection>
      ) : null}
      {task?.prompt ? (
        <InspectorSection
          title={translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.793491f358',
            'Prompt sent'
          )}
          defaultOpen={false}
        >
          <WorkflowPromptSections prompt={task.prompt} />
        </InspectorSection>
      ) : null}
      {tasks.length > 1 ? (
        <InspectorSection
          title={translate(
            'auto.components.workflows.inspector.NodeExecutionInspector.eb4be7f9b7',
            'Earlier revisions'
          )}
          defaultOpen={false}
        >
          {tasks.slice(1).map((earlier) => (
            <Row
              key={earlier.key}
              label={translate(
                'auto.components.workflows.inspector.NodeExecutionInspector.51e3b72c49',
                'Revision {{value0}}',
                { value0: earlier.iteration + 1 }
              )}
              value={WORKFLOW_TASK_STATUS_STYLE[earlier.status].label}
            />
          ))}
        </InspectorSection>
      ) : null}
    </>
  )
}
