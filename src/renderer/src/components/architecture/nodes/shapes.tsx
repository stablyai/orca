import type {
  ArchitectureDiagramKind,
  ArchitectureDiagramShape
} from '../architecture-diagram-types'
import {
  baseRectPath,
  bucketParts,
  cylinderParts,
  hexagonPath,
  personPath,
  pipeParts,
  rectanglePath,
  trapezoidPath
} from './shape-paths'

const W = 180
const H = 160

const KIND_DEFAULTS: Record<ArchitectureDiagramKind, ArchitectureDiagramShape> = {
  person: 'person',
  system: 'rectangle',
  container: 'rectangle',
  component: 'rectangle',
  operation: 'rectangle',
  process: 'rectangle',
  model: 'rectangle'
}

export function resolveShape(
  kind: ArchitectureDiagramKind,
  shape?: ArchitectureDiagramShape
): ArchitectureDiagramShape {
  return shape ?? KIND_DEFAULTS[kind]
}

function ShapePaths({
  shape,
  fill,
  stroke,
  strokeWidth,
  strokeDasharray
}: {
  shape: ArchitectureDiagramShape
  fill: string
  stroke: string
  strokeWidth: number
  strokeDasharray?: string
}): React.JSX.Element {
  const base = <path d={baseRectPath(W, H)} fill={fill} />
  const props = { fill, stroke, strokeWidth, strokeDasharray }

  switch (shape) {
    case 'person':
      return <path d={personPath(W, H)} {...props} />
    case 'cylinder': {
      const parts = cylinderParts(W, H)
      return (
        <>
          {base}
          <path d={parts.body} {...props} />
          <path d={parts.topCap} {...props} />
        </>
      )
    }
    case 'pipe': {
      const parts = pipeParts(W, H)
      return (
        <>
          {base}
          <path d={parts.body} {...props} />
          <path d={parts.rightCap} {...props} />
        </>
      )
    }
    case 'trapezoid':
      return (
        <>
          {base}
          <path d={trapezoidPath(W, H)} {...props} />
        </>
      )
    case 'bucket': {
      const parts = bucketParts(W, H)
      return (
        <>
          {base}
          <path d={parts.body} {...props} />
          <path d={parts.topCap} {...props} />
        </>
      )
    }
    case 'hexagon':
      return (
        <>
          {base}
          <path d={hexagonPath(W, H)} {...props} />
        </>
      )
    case 'rectangle':
      return <path d={rectanglePath(W, H)} {...props} />
  }
}

export function ShapeBackground({
  shape,
  kind,
  external,
  changed,
  selected,
  statusStroke
}: {
  shape: ArchitectureDiagramShape
  kind: ArchitectureDiagramKind
  external?: boolean
  changed?: boolean
  selected?: boolean
  statusStroke?: string
}): React.JSX.Element {
  const fill = external ? 'var(--scryer-ext-bg)' : 'var(--scryer-node-bg)'
  const stroke = selected
    ? 'var(--scryer-select-stroke)'
    : (statusStroke ?? (external ? 'var(--scryer-outline-stroke)' : 'var(--border)'))
  const strokeWidth = selected ? 2.5 : statusStroke ? 2 : 1

  return (
    <svg
      className="architecture-node-shape absolute inset-0 overflow-visible"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      data-testid="architecture-node-shape"
    >
      {kind === 'container' && shape === 'rectangle' ? (
        <path
          d="M0,0 V-9 Q0,-12 3,-12 H39 Q42,-12 44,-9 L45,0"
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={external ? '6 3' : undefined}
        />
      ) : null}
      <ShapePaths
        shape={shape}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={external ? '6 3' : undefined}
      />
      {kind === 'system' && shape === 'rectangle' ? (
        <rect
          x={-6}
          y={-6}
          width={W + 12}
          height={H + 12}
          rx={6}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
          strokeDasharray={external ? '6 3' : undefined}
        />
      ) : null}
      {kind === 'component' && shape === 'rectangle' ? (
        <>
          <rect
            x={-8}
            y={47}
            width={12}
            height={20}
            rx={2}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <rect
            x={-8}
            y={93}
            width={12}
            height={20}
            rx={2}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        </>
      ) : null}
      {changed ? (
        <path
          className="scryer-changed-glow"
          d={shape === 'person' ? personPath(W, H) : rectanglePath(W, H)}
          fill="none"
          stroke="var(--color-violet-400, #a78bfa)"
          strokeWidth={3}
        />
      ) : null}
    </svg>
  )
}
