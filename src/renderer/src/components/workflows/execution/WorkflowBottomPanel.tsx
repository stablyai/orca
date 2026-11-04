import React, { useCallback, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import { useWorkflowRunViewStore } from '../workflow-run-view-store'
import { WorkflowTimeline } from './WorkflowTimeline'
import { WorkflowMessageLog } from './WorkflowMessageLog'
import { WorkflowMetricsView } from './WorkflowMetricsView'
import { WorkflowRunHistory } from './WorkflowRunHistory'
import { translate } from '@/i18n/i18n'

const MIN_HEIGHT = 140
const MAX_HEIGHT = 640

function IssuesList(): React.JSX.Element {
  const issues = useWorkflowEditorStore((state) => state.issues)
  const select = useWorkflowEditorStore((state) => state.select)
  if (issues.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        {translate(
          'auto.components.workflows.execution.WorkflowBottomPanel.921ac18c46',
          'Validate to check the workflow. No issues recorded.'
        )}
      </p>
    )
  }
  return (
    <ul className="h-full overflow-y-auto scrollbar-sleek">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.nodeId ?? issue.edgeId ?? ''}:${issue.message}`}>
          <button
            type="button"
            className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => {
              if (issue.nodeId) {
                select({ kind: 'nodes', ids: [issue.nodeId] })
              } else if (issue.edgeId) {
                const preset = useWorkflowEditorStore.getState().preset
                const dependency = preset?.definition.dependencies.some(
                  (edge) => edge.id === issue.edgeId
                )
                select({ kind: dependency ? 'dependency' : 'communication', id: issue.edgeId })
              }
            }}
          >
            <span
              className={cn(
                'mt-1.5 size-1.5 shrink-0 rounded-full',
                issue.severity === 'error' ? 'bg-destructive' : 'bg-status-warning'
              )}
              aria-hidden
            />
            <span className="w-14 shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              {issue.severity}
            </span>
            <span className="min-w-0 flex-1 leading-5">{issue.message}</span>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {issue.nodeId ?? issue.edgeId ?? ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function NoRun(): React.JSX.Element {
  return (
    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
      {translate(
        'auto.components.workflows.execution.WorkflowBottomPanel.8e4a64acd8',
        'Run the workflow, or open a past run from History.'
      )}
    </p>
  )
}

export function WorkflowBottomPanel({
  historyTarget
}: {
  historyTarget: RuntimeClientTarget
}): React.JSX.Element {
  const run = useWorkflowRunViewStore((state) => state.run)
  const metrics = useWorkflowRunViewStore((state) => state.metrics)
  const error = useWorkflowRunViewStore((state) => state.error)
  const issueCount = useWorkflowEditorStore((state) => state.issues.length)
  // Collapsed until there is something to show: a run, or validation output.
  const [open, setOpen] = useState(() => run !== null || issueCount > 0)
  const [height, setHeight] = useState(220)
  const hasContent = run !== null || issueCount > 0
  const [autoOpened, setAutoOpened] = useState(hasContent)
  if (hasContent && !autoOpened) {
    setAutoOpened(true)
    setOpen(true)
  }
  const [tab, setTab] = useState('timeline')
  const drag = useRef<{ startY: number; startHeight: number } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      drag.current = { startY: event.clientY, startHeight: height }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [height]
  )
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (drag.current) {
      setHeight(
        Math.min(
          MAX_HEIGHT,
          Math.max(MIN_HEIGHT, drag.current.startHeight + drag.current.startY - event.clientY)
        )
      )
    }
  }, [])

  return (
    <div
      className="flex shrink-0 flex-col border-t border-border bg-background"
      style={{ height: open ? height : 36 }}
    >
      {open ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={translate(
            'auto.components.workflows.execution.WorkflowBottomPanel.2072d3b099',
            'Resize panel'
          )}
          tabIndex={0}
          className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-border focus-visible:bg-ring"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              setHeight((current) =>
                Math.min(
                  MAX_HEIGHT,
                  Math.max(MIN_HEIGHT, current + (event.key === 'ArrowUp' ? 24 : -24))
                )
              )
            }
          }}
        />
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value)
          setOpen(true)
        }}
        className="flex min-h-0 flex-1"
      >
        <div className="flex h-8 shrink-0 items-center gap-2 px-2">
          <TabsList variant="line" size="sm">
            <TabsTrigger value="timeline">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.7d6d2eacb7',
                'Timeline'
              )}
            </TabsTrigger>
            <TabsTrigger value="messages">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.0b74c800f7',
                'Messages'
              )}
              {run ? ` ${run.messages.length}` : ''}
            </TabsTrigger>
            <TabsTrigger value="metrics">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.2feac58710',
                'Metrics'
              )}
            </TabsTrigger>
            <TabsTrigger value="output">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.d0eb0230ba',
                'Output'
              )}
            </TabsTrigger>
            <TabsTrigger value="errors">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.949f2477eb',
                'Errors'
              )}
            </TabsTrigger>
            <TabsTrigger value="issues">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.d8829d2dd4',
                'Validation'
              )}
              {issueCount ? ` ${issueCount}` : ''}
            </TabsTrigger>
            <TabsTrigger value="history">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.b23cf357fc',
                'History'
              )}
            </TabsTrigger>
          </TabsList>
          {error ? (
            <span className="truncate text-2xs text-destructive">
              {translate(
                'auto.components.workflows.execution.WorkflowBottomPanel.59d739336b',
                'Could not refresh the run:'
              )}{' '}
              {error}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={
              open
                ? translate(
                    'auto.components.workflows.execution.WorkflowBottomPanel.5b08b6410a',
                    'Collapse panel'
                  )
                : translate(
                    'auto.components.workflows.execution.WorkflowBottomPanel.d455ed4271',
                    'Expand panel'
                  )
            }
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>
        {open ? (
          <div className="min-h-0 flex-1 border-t border-border">
            <TabsContent value="timeline" className="h-full">
              {run ? <WorkflowTimeline run={run} /> : <NoRun />}
            </TabsContent>
            <TabsContent value="messages" className="h-full">
              {run ? <WorkflowMessageLog run={run} /> : <NoRun />}
            </TabsContent>
            <TabsContent value="metrics" className="h-full">
              {run && metrics ? <WorkflowMetricsView run={run} metrics={metrics} /> : <NoRun />}
            </TabsContent>
            <TabsContent value="output" className="h-full">
              <div className="h-full overflow-y-auto p-3 scrollbar-sleek">
                {run ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">
                    {run.finalOutput ??
                      (run.error
                        ? translate(
                            'auto.components.workflows.execution.WorkflowBottomPanel.dc85bc7696',
                            'Run failed: {{value0}}',
                            { value0: run.error }
                          )
                        : translate(
                            'auto.components.workflows.execution.WorkflowBottomPanel.0a1901f98f',
                            'No output yet; the End node collects it.'
                          ))}
                  </pre>
                ) : (
                  <NoRun />
                )}
              </div>
            </TabsContent>
            <TabsContent value="errors" className="h-full">
              {run ? <WorkflowTimeline run={run} onlyErrors /> : <NoRun />}
            </TabsContent>
            <TabsContent value="issues" className="h-full">
              <IssuesList />
            </TabsContent>
            <TabsContent value="history" className="h-full">
              <WorkflowRunHistory target={historyTarget} />
            </TabsContent>
          </div>
        ) : null}
      </Tabs>
    </div>
  )
}
