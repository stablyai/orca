import React, { useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Loader2 } from 'lucide-react'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { useWorkflowRunViewStore, useWorkflowRunPolling } from './workflow-run-view-store'
import { useWorkflowPresets } from './use-workflow-presets'
import { useWorkflowEditorShortcuts } from './use-workflow-editor-shortcuts'
import { LOCAL_WORKFLOW_TARGET } from './workflow-rpc'
import { WorkflowToolbar } from './WorkflowToolbar'
import { WorkflowNodePalette } from './WorkflowNodePalette'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowInspector } from './inspector/WorkflowInspector'
import { WorkflowBottomPanel } from './execution/WorkflowBottomPanel'
import { WorkflowRunDialog } from './WorkflowRunDialog'
import { translate } from '@/i18n/i18n'

function WorkflowsWorkspace(): React.JSX.Element {
  const controls = useWorkflowPresets()
  const preset = useWorkflowEditorStore((state) => state.preset)
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const runTarget = useWorkflowRunViewStore((state) => state.target)
  const [runOpen, setRunOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useWorkflowRunPolling()
  useWorkflowEditorShortcuts(root, () => void controls.save())

  if (!preset) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        {controls.loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          translate(
            'auto.components.workflows.WorkflowsPage.f8e09dbeac',
            'No workflows are available.'
          )
        )}
      </div>
    )
  }
  return (
    <div
      ref={root}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      data-testid="workflow-builder"
    >
      <WorkflowToolbar controls={controls} onRun={() => setRunOpen(true)} />
      <div className="flex min-h-0 flex-1">
        {execution ? null : <WorkflowNodePalette />}
        <div className="relative min-w-0 flex-1">
          <WorkflowCanvas />
        </div>
        <aside
          aria-label={translate('auto.components.workflows.WorkflowsPage.7f4ebd548f', 'Inspector')}
          className="w-[340px] shrink-0 overflow-y-auto border-l border-border bg-background scrollbar-sleek"
        >
          <WorkflowInspector />
        </aside>
      </div>
      <WorkflowBottomPanel historyTarget={runTarget ?? LOCAL_WORKFLOW_TARGET} />
      {runOpen ? (
        <WorkflowRunDialog
          key={preset.id}
          preset={preset}
          open={runOpen}
          onOpenChange={setRunOpen}
        />
      ) : null}
    </div>
  )
}

/** Visual multi-agent workflow editor and run monitor. */
export default function WorkflowsPage(): React.JSX.Element {
  return (
    <main className="flex h-full min-h-0 flex-1 flex-col bg-background text-foreground">
      <ReactFlowProvider>
        <WorkflowsWorkspace />
      </ReactFlowProvider>
    </main>
  )
}
