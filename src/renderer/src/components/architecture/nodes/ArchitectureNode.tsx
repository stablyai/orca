import type { DragEvent } from 'react'
import { Boxes, Code, Layers, Link, Maximize2, RefreshCw, Table, Workflow } from 'lucide-react'
import type { Node, NodeProps } from '@xyflow/react'
import type {
  ArchitectureDiagramNodeData,
  ArchitectureSourceLocation,
  ArchitectureStatus
} from '../architecture-diagram-types'
import { Button } from '../../ui/button'
import { DescriptionText } from './DescriptionText'
import { ContractBadge } from './ContractBadge'
import { HintBadge } from './HintBadge'
import { NodeHandles } from './NodeHandles'
import { ShapeBackground, resolveShape } from './shapes'
import { STATUS_COLORS } from './status-colors'

export type ArchitectureNodeData = ArchitectureDiagramNodeData & {
  sourceLocations?: ArchitectureSourceLocation[]
  onExpand?: () => void
  onOpenSourceLocation?: (location: ArchitectureSourceLocation) => void | Promise<void>
  _inspectorSelected?: boolean
  _groupName?: string
  _changed?: boolean
  _drifted?: boolean
  _hasChildren?: boolean
  _hints?: { severity: 'info' | 'warning' }[]
  _processes?: { id: string; name: string; status?: ArchitectureStatus }[]
  _models?: { id: string; name: string; status?: ArchitectureStatus }[]
}

export type ArchitectureFlowNode = Node<ArchitectureNodeData, string>

const KIND_CHIP_ICON = {
  process: Workflow,
  model: Table,
  operation: Code
}

function isExpandable(kind: ArchitectureDiagramNodeData['kind']): boolean {
  return kind === 'system' || kind === 'container' || kind === 'component'
}

function MemberChipList({
  operations,
  processes,
  models,
  dimmed
}: {
  operations?: { id: string; name: string; status?: string }[]
  processes?: { id: string; name: string; status?: string }[]
  models?: { id: string; name: string; status?: string }[]
  dimmed?: boolean
}): React.JSX.Element | null {
  const items = [
    ...(processes ?? []).map((item) => ({ ...item, kind: 'process' as const })),
    ...(models ?? []).map((item) => ({ ...item, kind: 'model' as const })),
    ...(operations ?? []).map((item) => ({ ...item, kind: 'operation' as const }))
  ]
  if (items.length === 0) {
    return null
  }
  const visible = items.slice(0, 8)
  const overflow = items.length - visible.length
  return (
    <div className="flex flex-col gap-1">
      {visible.map((item) => {
        const Icon = KIND_CHIP_ICON[item.kind]
        const color = item.status
          ? STATUS_COLORS[item.status as ArchitectureStatus]?.stroke
          : undefined
        return (
          <div
            key={item.id}
            draggable
            className={`nodrag flex cursor-grab items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-tight ${
              dimmed ? 'bg-muted/40 text-muted-foreground' : 'bg-muted text-foreground/80'
            }`}
            style={color ? { borderColor: color } : undefined}
            onDragStart={(event: DragEvent) => {
              event.dataTransfer.setData('text/plain', item.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
          >
            <Icon size={10} className="shrink-0 opacity-60" />
            <span className="truncate">{item.name || 'unnamed'}</span>
          </div>
        )
      })}
      {overflow > 0 ? (
        <div className="py-0.5 text-center font-mono text-[10px] text-muted-foreground">
          +{overflow} more
        </div>
      ) : null}
    </div>
  )
}

function SourceLinks({
  locations,
  onOpenSourceLocation
}: {
  locations?: ArchitectureSourceLocation[]
  onOpenSourceLocation?: (location: ArchitectureSourceLocation) => void | Promise<void>
}): React.JSX.Element | null {
  if (!locations?.length) {
    return null
  }
  return (
    <div className="mt-2 flex flex-wrap justify-center gap-1">
      {locations.map((location, index) => (
        <Button
          key={`${location.pattern}-${index}`}
          variant="outline"
          size="xs"
          className="nodrag h-6 max-w-full justify-start px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation()
            void onOpenSourceLocation?.(location)
          }}
          data-testid="architecture-source-link"
          title={location.pattern}
        >
          <Link className="size-3" />
          <span className="truncate">{location.pattern}</span>
        </Button>
      ))}
    </div>
  )
}

function PersonNode({
  id,
  data,
  selected
}: {
  id: string
  data: ArchitectureNodeData
  selected: boolean
}): React.JSX.Element {
  const silhouetteFill = 'var(--scryer-person-fill)'
  const longDescription = (data.description?.length ?? 0) > 80
  return (
    <div
      className="architecture-node-drag-surface relative h-[160px] w-[180px]"
      data-testid="architecture-node"
      data-node-id={id}
      data-node-kind={data.kind}
      data-node-shape="person"
    >
      <HintBadge hints={data._hints ?? []} />
      <NodeHandles hidden={!!data._reference} />
      <div
        className="absolute flex flex-col items-center justify-center overflow-visible text-foreground"
        style={{ top: longDescription ? -20 : 6, bottom: 6, left: 8, right: 8 }}
      >
        <svg
          className="pointer-events-none shrink-0 overflow-visible"
          width="200"
          height="80"
          viewBox="0 0 180 72"
          style={{ marginBottom: -34 }}
          data-testid="architecture-node-shape"
        >
          <defs>
            <linearGradient id={`person-fade-${id}`} x1="0" y1="40" x2="0" y2="72">
              <stop offset="0%" stopColor={silhouetteFill} stopOpacity="1" />
              <stop offset="100%" stopColor={silhouetteFill} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M 33,72 C 33,42 48,28 76,24 A 22,26 0 1,1 104,24 C 132,28 147,42 147,72 Z"
            fill={`url(#person-fade-${id})`}
          />
          <path
            d="M 33,72 C 33,42 48,28 76,24 A 22,26 0 1,1 104,24 C 132,28 147,42 147,72"
            fill="none"
            stroke={selected ? 'var(--scryer-select-stroke)' : 'var(--scryer-outline-stroke)'}
            strokeWidth={selected ? 2.5 : 1}
          />
        </svg>
        <div
          className="architecture-node-title w-full break-all text-center text-sm font-semibold leading-tight"
          data-testid="architecture-node-title"
        >
          {data.name}
        </div>
        {data.description ? (
          <div className="mt-2 w-full overflow-hidden break-words text-center text-[10px] leading-snug text-muted-foreground">
            <DescriptionText text={data.description} />
          </div>
        ) : null}
        <SourceLinks
          locations={data.sourceLocations}
          onOpenSourceLocation={data.onOpenSourceLocation}
        />
      </div>
    </div>
  )
}

export function ArchitectureNode({
  id,
  data,
  selected
}: NodeProps<ArchitectureFlowNode>): React.JSX.Element {
  const inspectorSelected = !!data._inspectorSelected
  const visualSelected = selected || inspectorSelected
  const reference = !!data._reference
  const external = !!data.external
  const expandable = isExpandable(data.kind) && !external && !reference
  const statusColor =
    data.status && data.kind !== 'person' && !external ? STATUS_COLORS[data.status] : undefined
  const shape = resolveShape(data.kind, data.shape)
  const hasMembers =
    !!data._operations?.length || !!data._processes?.length || !!data._models?.length

  if (data.kind === 'person') {
    return <PersonNode id={id} data={data} selected={visualSelected} />
  }

  return (
    <div
      className={`architecture-node-drag-surface relative w-[180px] ${reference ? 'opacity-75' : ''}`}
      data-testid="architecture-node"
      data-node-id={id}
      data-node-kind={data.kind}
      data-node-shape={shape}
      onDoubleClick={(event) => {
        if (!expandable) {
          return
        }
        event.stopPropagation()
        data.onExpand?.()
      }}
    >
      <div className="relative h-[160px]">
        <HintBadge hints={data._hints ?? []} />
        <ContractBadge contract={data.contract} />
        <ShapeBackground
          shape={shape}
          kind={data.kind}
          external={external || reference}
          changed={!!data._changed}
          selected={visualSelected}
          statusStroke={statusColor?.dimStroke}
        />
        <NodeHandles hidden={reference} />

        {expandable && visualSelected ? (
          <button
            type="button"
            className="nodrag absolute right-1.5 top-1.5 z-10 flex size-5 items-center justify-center rounded bg-muted text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation()
              data.onExpand?.()
            }}
            title="Drill into node"
          >
            <Maximize2 className="size-3" />
          </button>
        ) : null}

        {data._drifted || data._groupName ? (
          <div className="pointer-events-none absolute bottom-2 left-2.5 z-10 flex items-center gap-1">
            {data._drifted ? <RefreshCw size={12} className="text-indigo-400" /> : null}
            {data._groupName ? (
              <span title={`group: ${data._groupName}`} className="text-slate-400">
                <Boxes size={12} strokeWidth={2} />
              </span>
            ) : null}
          </div>
        ) : null}

        {expandable && data._hasChildren ? (
          <div className="pointer-events-none absolute bottom-2 right-2.5 z-10 text-muted-foreground">
            <Layers size={12} strokeWidth={1.5} />
          </div>
        ) : null}

        <div className="absolute inset-x-2 bottom-2 top-2 flex flex-col items-center justify-center overflow-hidden text-center text-foreground">
          <div
            className="architecture-node-title w-full break-all text-sm font-semibold leading-tight"
            data-testid="architecture-node-title"
          >
            {reference && data._relationships?.[0]?.direction ? (
              <span className="text-muted-foreground">
                {data._relationships[0].direction === 'out' ? '<- ' : '-> '}
              </span>
            ) : null}
            {data.name}
          </div>
          {data.technology ? (
            <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {data.technology}
            </div>
          ) : null}
          {data.status ? (
            <div className={`mt-1 text-[10px] ${statusColor?.text ?? 'text-muted-foreground'}`}>
              {data.status}
            </div>
          ) : null}
          {data.description ? (
            <div className="mt-2 w-full overflow-hidden break-words text-[10px] leading-snug text-muted-foreground">
              <DescriptionText text={data.description} />
            </div>
          ) : null}
          {!reference ? (
            <SourceLinks
              locations={data.sourceLocations}
              onOpenSourceLocation={data.onOpenSourceLocation}
            />
          ) : null}
        </div>
      </div>

      {data.kind === 'component' && hasMembers ? (
        <div className="w-full px-2 py-1.5">
          <MemberChipList
            operations={data._operations}
            processes={data._processes}
            models={data._models}
            dimmed={reference}
          />
        </div>
      ) : null}
    </div>
  )
}
