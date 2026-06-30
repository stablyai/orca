import { EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react'
import type { ArchitectureDiagramLinkData, ArchitectureStatus } from '../architecture-diagram-types'
import { statusHex } from '../nodes/status-colors'

type RelationshipEdgeData = ArchitectureDiagramLinkData & {
  _status?: ArchitectureStatus
  _highlighted?: boolean
  _dimmed?: boolean
  _mention?: boolean
  _biPair?: boolean
  _onSelect?: (edgeId: string) => void
}

export type ArchitectureFlowEdge = Edge<RelationshipEdgeData, 'relationship'>

function roundedPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) {
    return ''
  }
  const radius = 30
  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]
    const current = points[index]
    const next = points[index + 1]
    const toPrevious = { x: previous.x - current.x, y: previous.y - current.y }
    const toNext = { x: next.x - current.x, y: next.y - current.y }
    const previousLength = Math.hypot(toPrevious.x, toPrevious.y) || 1
    const nextLength = Math.hypot(toNext.x, toNext.y) || 1
    const bendRadius = Math.min(radius, previousLength / 2, nextLength / 2)
    const start = {
      x: current.x + (toPrevious.x / previousLength) * bendRadius,
      y: current.y + (toPrevious.y / previousLength) * bendRadius
    }
    const end = {
      x: current.x + (toNext.x / nextLength) * bendRadius,
      y: current.y + (toNext.y / nextLength) * bendRadius
    }
    path += ` L ${start.x} ${start.y} Q ${current.x} ${current.y} ${end.x} ${end.y}`
  }
  const last = points.at(-1)!
  return `${path} L ${last.x} ${last.y}`
}

function longestSegmentMidpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  let best = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 }
  let bestLength = -1
  for (let index = 0; index < points.length - 1; index++) {
    const left = points[index]
    const right = points[index + 1]
    const length = Math.hypot(right.x - left.x, right.y - left.y)
    if (length > bestLength) {
      bestLength = length
      best = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
    }
  }
  return best
}

export function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  selected
}: EdgeProps<ArchitectureFlowEdge>): React.JSX.Element {
  const pairShift = data?._biPair ? 4 : 0
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const length = Math.hypot(dx, dy) || 1
  const ox = (-dy / length) * pairShift
  const oy = (dx / length) * pairShift
  const start = { x: sourceX + ox, y: sourceY + oy }
  const end = { x: targetX + ox, y: targetY + oy }
  const route = (data?._route ?? []).map((point) => ({ x: point.x + ox, y: point.y + oy }))
  const points = [start, ...route, end]
  const path = route.length ? roundedPath(points) : `M ${start.x} ${start.y} L ${end.x} ${end.y}`
  const labelPoint = route.length
    ? longestSegmentMidpoint(points)
    : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const previous = points.at(-2) ?? start
  const arrowAngle = Math.atan2(end.y - previous.y, end.x - previous.x)
  const arrowSize = 8
  const arrowLeft = {
    x: end.x - arrowSize * Math.cos(arrowAngle - Math.PI / 6),
    y: end.y - arrowSize * Math.sin(arrowAngle - Math.PI / 6)
  }
  const arrowRight = {
    x: end.x - arrowSize * Math.cos(arrowAngle + Math.PI / 6),
    y: end.y - arrowSize * Math.sin(arrowAngle + Math.PI / 6)
  }
  const color = selected
    ? 'var(--scryer-select-stroke)'
    : data?._mention
      ? 'var(--muted-foreground)'
      : (statusHex(data?._status) ?? 'rgba(148,163,184,0.8)')
  const opacity = data?._mention
    ? data._highlighted
      ? 0.6
      : data._dimmed
        ? 0.15
        : 0.4
    : selected || data?._highlighted
      ? 1
      : data?._dimmed
        ? 0.25
        : 0.72

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="react-flow__edge-interaction"
      />
      <g opacity={opacity}>
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={data?._mention ? 1 : selected ? 2.5 : 1.5}
          strokeDasharray={data?._mention ? undefined : '6 3'}
          className={data?._mention ? undefined : 'scryer-dash-flow'}
          data-testid="architecture-edge-path"
          data-edge-id={id}
          data-routed={route.length ? 'true' : 'false'}
        />
        {!data?._mention ? (
          <polygon
            points={`${end.x},${end.y} ${arrowLeft.x},${arrowLeft.y} ${arrowRight.x},${arrowRight.y}`}
            fill={color}
          />
        ) : null}
      </g>
      <circle cx={labelPoint.x} cy={labelPoint.y} r={4} fill={color} className="edge-handle-dot" />
      {data?.label || data?.method ? (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelPoint.x}px,${labelPoint.y}px)`,
              zIndex: 1,
              pointerEvents: 'all',
              ...(data?._dimmed ? { opacity: 0.25 } : {})
            }}
            className="flex flex-col items-center"
            data-testid="architecture-edge-label"
            data-edge-id={id}
            onClick={(event) => {
              event.stopPropagation()
              data?._onSelect?.(id)
            }}
          >
            {data.label ? (
              <div className="whitespace-nowrap rounded bg-background/90 px-1.5 py-0.5 text-[10px] text-foreground shadow-sm">
                {data.label}
              </div>
            ) : null}
            {data.method ? (
              <div className="whitespace-nowrap text-[9px] text-muted-foreground">
                [{data.method}]
              </div>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
