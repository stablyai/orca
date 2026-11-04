import React, { useEffect, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  useStore,
  type EdgeProps
} from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { WorkflowFlowEdge } from './workflow-flow-mapping'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { useWorkflowRunViewStore, WORKFLOW_EDGE_ACTIVITY_MS } from './workflow-run-view-store'
import { translate } from '@/i18n/i18n'

function EdgeChip({
  x,
  y,
  children,
  selected
}: {
  x: number
  y: number
  children: React.ReactNode
  selected: boolean
}) {
  return (
    <EdgeLabelRenderer>
      <div
        className={cn(
          'absolute rounded-md border bg-background px-1.5 py-0.5 text-3xs font-medium text-muted-foreground',
          selected ? 'border-ring text-foreground' : 'border-border'
        )}
        style={{
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          zIndex: selected ? 1001 : undefined
        }}
      >
        {children}
      </div>
    </EdgeLabelRenderer>
  )
}

/** A loop runs back up the graph, so route it in a side lane instead of through the nodes it re-runs. */
function loopPath(
  props: EdgeProps<WorkflowFlowEdge>,
  leftmostNodeX: number
): [string, number, number] {
  const { sourceX, sourceY, targetX, targetY } = props
  const lane = Math.min(sourceX, targetX, leftmostNodeX) - 40
  const below = sourceY + 18
  const above = targetY - 18
  const r = 10
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX} ${below - r}`,
    `Q ${sourceX} ${below} ${sourceX - r} ${below}`,
    `L ${lane + r} ${below}`,
    `Q ${lane} ${below} ${lane} ${below - r}`,
    `L ${lane} ${above + r}`,
    `Q ${lane} ${above} ${lane + r} ${above}`,
    `L ${targetX - r} ${above}`,
    `Q ${targetX} ${above} ${targetX} ${above + r}`,
    `L ${targetX} ${targetY}`
  ].join(' ')
  return [path, lane, (below + above) / 2]
}

function DependencyEdgeImpl(props: EdgeProps<WorkflowFlowEdge>): React.JSX.Element {
  // A number selector stays stable, so only real layout changes re-route loops.
  const leftmostNodeX = useStore((state) => {
    let min = Number.POSITIVE_INFINITY
    for (const node of state.nodeLookup.values()) {
      min = Math.min(min, node.internals.positionAbsolute.x)
    }
    return Number.isFinite(min) ? min : 0
  })
  const [path, labelX, labelY] =
    props.data?.loop && props.targetY < props.sourceY
      ? loopPath(props, leftmostNodeX)
      : getSmoothStepPath({ ...props, borderRadius: 10, offset: 18 })
  const loopLimit = useWorkflowEditorStore((state) => {
    const edge = state.preset?.definition.dependencies.find(
      (candidate) => candidate.id === props.data?.edgeId
    )
    return edge?.loop?.maxIterations ?? null
  })
  const taken = useWorkflowRunViewStore((state) =>
    state.run && props.data ? (state.run.edgeStates[props.data.edgeId] ?? null) : null
  )
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const stroke = props.selected
    ? 'var(--ring)'
    : execution && taken === 'taken'
      ? 'var(--foreground)'
      : 'color-mix(in srgb, var(--muted-foreground) 70%, transparent)'
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{
          stroke,
          strokeWidth: props.selected ? 2 : 1.5,
          strokeDasharray: props.data?.loop ? '6 4' : undefined,
          opacity: execution && taken === 'not-taken' ? 0.35 : 1
        }}
      />
      {props.data?.label || loopLimit ? (
        <EdgeChip x={labelX} y={labelY} selected={Boolean(props.selected)}>
          {props.data?.label}
          {loopLimit
            ? translate(
                'auto.components.workflows.WorkflowEdges.3a4be452f9',
                ' · up to {{value0}} revisions',
                { value0: loopLimit }
              )
            : ''}
        </EdgeChip>
      ) : null}
    </>
  )
}

function useRecentActivity(edgeId: string | undefined): boolean {
  const lastAt = useWorkflowRunViewStore((state) =>
    edgeId ? (state.edgeActivity[edgeId] ?? 0) : 0
  )
  const [active, setActive] = useState(false)
  useEffect(() => {
    const remaining = lastAt + WORKFLOW_EDGE_ACTIVITY_MS - Date.now()
    if (remaining <= 0) {
      setActive(false)
      return
    }
    setActive(true)
    const timer = setTimeout(() => setActive(false), remaining)
    return () => clearTimeout(timer)
  }, [lastAt])
  return active
}

function CommunicationEdgeImpl(props: EdgeProps<WorkflowFlowEdge>): React.JSX.Element {
  const [path, labelX, labelY] = getBezierPath({ ...props, curvature: 0.35 })
  const edgeId = props.data?.edgeId
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const enabled = useWorkflowEditorStore(
    (state) =>
      state.preset?.definition.communication.find((edge) => edge.id === edgeId)?.enabled ?? true
  )
  const counts = useWorkflowRunViewStore((state) => {
    if (!execution || !state.run || !edgeId) {
      return ''
    }
    const onEdge = state.run.messages.filter((message) => message.edgeId === edgeId)
    const rejected = onEdge.filter((message) => message.deliveryState === 'rejected').length
    return `${onEdge.length - rejected}${rejected > 0 ? ` · ${rejected} refused` : ''}`
  })
  const active = useRecentActivity(edgeId)
  // Route labels crowd the design view; show them where they answer a question.
  const showLabel =
    useWorkflowEditorStore((state) => state.layer === 'communication') ||
    execution ||
    Boolean(props.selected)
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        className={cn(active && 'workflow-edge-flowing')}
        style={{
          stroke: props.selected
            ? 'var(--ring)'
            : active
              ? 'var(--foreground)'
              : 'var(--muted-foreground)',
          strokeWidth: props.selected || active ? 1.75 : 1.25,
          strokeDasharray: props.selected ? undefined : '2 4',
          opacity: enabled ? 0.9 : 0.35
        }}
      />
      {showLabel || !enabled ? (
        <EdgeChip x={labelX} y={labelY} selected={Boolean(props.selected)}>
          {execution && counts
            ? translate('auto.components.workflows.WorkflowEdges.f65b6ab7a5', '{{value0}} msg', {
                value0: counts
              })
            : props.data?.label}
          {!enabled ? translate('auto.components.workflows.WorkflowEdges.3178e51538', '· off') : ''}
        </EdgeChip>
      ) : null}
    </>
  )
}

export const WORKFLOW_EDGE_TYPES = {
  dependency: React.memo(DependencyEdgeImpl),
  communication: React.memo(CommunicationEdgeImpl)
}
