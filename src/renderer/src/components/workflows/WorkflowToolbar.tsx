import React, { useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { CheckCircle2, LayoutGrid, Loader2, Maximize, Redo2, Save, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useWorkflowEditorStore, type WorkflowEdgeLayer } from './workflow-editor-store'
import { useWorkflowRunViewStore } from './workflow-run-view-store'
import { workflowEditorActions } from './workflow-editor-actions'
import { workflowRpc, LOCAL_WORKFLOW_TARGET } from './workflow-rpc'
import type { WorkflowPresetControls } from './use-workflow-presets'
import { WorkflowPresetMenu } from './WorkflowPresetMenu'
import { WorkflowRunControls } from './WorkflowRunControls'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const EDGE_LAYERS: readonly WorkflowEdgeLayer[] = ['all', 'execution', 'communication']
const MOD = isMac ? '⌘' : 'Ctrl+'

function IconAction({
  label,
  onClick,
  disabled,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorkflowToolbar({
  controls,
  onRun
}: {
  controls: WorkflowPresetControls
  onRun: () => void
}): React.JSX.Element {
  const flow = useReactFlow()
  const mode = useWorkflowEditorStore((state) => state.mode)
  const layer = useWorkflowEditorStore((state) => state.layer)
  const canUndo = useWorkflowEditorStore((state) => state.past.length > 0)
  const canRedo = useWorkflowEditorStore((state) => state.future.length > 0)
  const issues = useWorkflowEditorStore((state) => state.issues)
  const hasRun = useWorkflowRunViewStore((state) => state.runId !== null)
  const [validating, setValidating] = useState(false)
  const design = mode === 'design'

  const validate = async (): Promise<void> => {
    const draft = useWorkflowEditorStore.getState().preset
    if (!draft) {
      return
    }
    setValidating(true)
    try {
      const result = await workflowRpc.validate(LOCAL_WORKFLOW_TARGET, draft.definition)
      useWorkflowEditorStore.getState().setIssues(result.issues)
      const errors = result.issues.filter((issue) => issue.severity === 'error').length
      if (errors === 0) {
        toast.success(
          result.issues.length
            ? translate(
                'auto.components.workflows.WorkflowToolbar.81311af7d8',
                'Valid, with {{value0}} warning(s)',
                { value0: result.issues.length }
              )
            : translate('auto.components.workflows.WorkflowToolbar.590bcdb715', 'Workflow is valid')
        )
      } else {
        toast.error(
          translate(
            'auto.components.workflows.WorkflowToolbar.b75632598d',
            '{{value0}} validation error(s)',
            { value0: errors }
          ),
          { description: result.issues[0]?.message }
        )
      }
    } catch (error) {
      toast.error(
        translate('auto.components.workflows.WorkflowToolbar.45da2f948a', 'Validation failed'),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setValidating(false)
    }
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <WorkflowPresetMenu controls={controls} />
      <div className="mx-1 h-5 w-px bg-border" />
      <IconAction
        label={translate(
          'auto.components.workflows.WorkflowToolbar.74c6b6f15d',
          'Save ({{value0}}S)',
          { value0: MOD }
        )}
        onClick={() => void controls.save()}
        disabled={!design}
      >
        <Save />
      </IconAction>
      <IconAction
        label={translate(
          'auto.components.workflows.WorkflowToolbar.4d80400661',
          'Undo ({{value0}}Z)',
          { value0: MOD }
        )}
        onClick={() => useWorkflowEditorStore.getState().undo()}
        disabled={!design || !canUndo}
      >
        <Undo2 />
      </IconAction>
      <IconAction
        label={
          isMac
            ? translate('auto.components.workflows.WorkflowToolbar.65bbfb196c', 'Redo (⌘⇧Z)')
            : translate('auto.components.workflows.WorkflowToolbar.2219181459', 'Redo (Ctrl+Y)')
        }
        onClick={() => useWorkflowEditorStore.getState().redo()}
        disabled={!design || !canRedo}
      >
        <Redo2 />
      </IconAction>
      <IconAction
        label={translate('auto.components.workflows.WorkflowToolbar.ba86d662bd', 'Auto-layout')}
        onClick={() => workflowEditorActions.autoLayout()}
        disabled={!design}
      >
        <LayoutGrid />
      </IconAction>
      <IconAction
        label={translate('auto.components.workflows.WorkflowToolbar.589dc34be2', 'Fit to view')}
        onClick={() => void flow.fitView({ padding: 0.2, duration: 200 })}
      >
        <Maximize />
      </IconAction>
      <div className="mx-1 h-5 w-px bg-border" />
      <ToggleGroup
        type="single"
        variant="segmented"
        size="xs"
        value={layer}
        onValueChange={(value) => {
          const layer = EDGE_LAYERS.find((candidate) => candidate === value)
          if (layer) {
            useWorkflowEditorStore.getState().setLayer(layer)
          }
        }}
        aria-label={translate(
          'auto.components.workflows.WorkflowToolbar.8e598de1e4',
          'Edges shown'
        )}
      >
        <ToggleGroupItem value="all">
          {translate('auto.components.workflows.WorkflowToolbar.e9991cf2e8', 'All edges')}
        </ToggleGroupItem>
        <ToggleGroupItem value="execution">
          {translate('auto.components.workflows.WorkflowToolbar.de72c254e9', 'Execution')}
        </ToggleGroupItem>
        <ToggleGroupItem value="communication">
          {translate('auto.components.workflows.WorkflowToolbar.7d2dc3a949', 'Routes')}
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void validate()} disabled={validating}>
          {validating ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          {translate('auto.components.workflows.WorkflowToolbar.2242c7f425', 'Validate')}
          {issues.length ? ` · ${issues.length}` : ''}
        </Button>
        <ToggleGroup
          type="single"
          variant="segmented"
          size="xs"
          value={mode}
          onValueChange={(value) => {
            if (value === 'design' || value === 'execution') {
              useWorkflowEditorStore.getState().setMode(value)
            }
          }}
          aria-label={translate('auto.components.workflows.WorkflowToolbar.0855e28b5f', 'Mode')}
        >
          <ToggleGroupItem value="design">
            {translate('auto.components.workflows.WorkflowToolbar.200533e79f', 'Design')}
          </ToggleGroupItem>
          <ToggleGroupItem value="execution" disabled={!hasRun}>
            {translate('auto.components.workflows.WorkflowToolbar.de72c254e9', 'Execution')}
          </ToggleGroupItem>
        </ToggleGroup>
        <WorkflowRunControls onRun={onRun} />
      </div>
    </div>
  )
}
