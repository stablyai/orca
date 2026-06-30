import { useEffect, useMemo, useRef } from 'react'
import { ArrowUp, Code, Plus, Table, Trash2, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  ArchitectureDiagramKind,
  ArchitectureDiagramNode,
  ArchitectureModelProperty,
  ArchitectureStatus
} from './architecture-diagram-types'
import { Button } from '../ui/button'
import { DescriptionText } from './nodes/DescriptionText'

const COLUMNS: { kind: ArchitectureDiagramKind; title: string; icon: LucideIcon }[] = [
  { kind: 'model', title: 'Models', icon: Table },
  { kind: 'operation', title: 'Operations', icon: Code },
  { kind: 'process', title: 'Processes', icon: Workflow }
]

const STATUS_DOT: Partial<Record<ArchitectureStatus, string>> = {
  proposed: 'bg-slate-400',
  implemented: 'bg-blue-400',
  verified: 'bg-emerald-400',
  vagrant: 'bg-amber-400'
}

export type CodeLevelRackProps = {
  nodes: ArchitectureDiagramNode[]
  selectedNodeId: string | null
  syncing: boolean
  parentName: string
  onNavigateUp: () => void
  onSelectNode: (nodeId: string) => void
  onAddNode: (kind: ArchitectureDiagramKind) => void | Promise<void>
  onDeleteNode: (nodeId: string) => void | Promise<void>
}

export function CodeLevelRack({
  nodes,
  selectedNodeId,
  syncing,
  parentName,
  onNavigateUp,
  onSelectNode,
  onAddNode,
  onDeleteNode
}: CodeLevelRackProps): React.JSX.Element {
  const nodesByKind = useMemo(() => {
    const result = new Map<ArchitectureDiagramKind, ArchitectureDiagramNode[]>()
    for (const node of nodes) {
      const list = result.get(node.data.kind) ?? []
      list.push(node)
      result.set(node.data.kind, list)
    }
    for (const [kind, list] of result) {
      result.set(
        kind,
        [...list].sort((left, right) => left.data.name.localeCompare(right.data.name))
      )
    }
    return result
  }, [nodes])
  const sortedNodes = useMemo(
    () =>
      [...nodes].sort((left, right) => {
        if (left.data.kind !== right.data.kind) {
          return left.data.kind.localeCompare(right.data.kind)
        }
        return left.data.name.localeCompare(right.data.name)
      }),
    [nodes]
  )
  const previousSelectedIdRef = useRef(selectedNodeId)
  const previousNodeIdsRef = useRef<string[]>([])
  const nodeMap = useMemo(() => {
    const map = new Map<string, { kind: string; status?: ArchitectureStatus }>()
    for (const node of nodes) {
      map.set(node.data.name, { kind: node.data.kind, status: node.data.status })
      map.set(node.id, { kind: node.data.kind, status: node.data.status })
    }
    return map
  }, [nodes])

  useEffect(() => {
    if (sortedNodes.length === 0) {
      previousSelectedIdRef.current = selectedNodeId
      previousNodeIdsRef.current = []
      return
    }
    if (selectedNodeId && sortedNodes.some((node) => node.id === selectedNodeId)) {
      previousSelectedIdRef.current = selectedNodeId
      previousNodeIdsRef.current = sortedNodes.map((node) => node.id)
      return
    }
    const oldIds = previousNodeIdsRef.current
    const oldSelected = previousSelectedIdRef.current
    if (oldSelected) {
      const oldIndex = oldIds.indexOf(oldSelected)
      for (const candidate of [oldIds[oldIndex + 1], oldIds[oldIndex - 1]]) {
        if (candidate && sortedNodes.some((node) => node.id === candidate)) {
          onSelectNode(candidate)
          return
        }
      }
    }
    onSelectNode(sortedNodes[0].id)
  }, [onSelectNode, selectedNodeId, sortedNodes])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--surface)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={onNavigateUp}
          data-testid="architecture-code-level-back"
        >
          <ArrowUp className="size-3" />
          Up
        </Button>
        <div className="truncate text-xs text-muted-foreground">
          Code level for <span className="text-foreground">{parentName}</span>
        </div>
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-3"
        data-testid="architecture-code-level-rack"
      >
        {COLUMNS.map(({ kind, title, icon: Icon }) => (
          <section
            key={kind}
            className="flex min-h-0 flex-col border-b border-border last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"
            data-testid="architecture-code-level-column"
            data-code-kind={kind}
          >
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
              <Icon className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-foreground/80">{title}</span>
              <span className="text-[10px] text-muted-foreground">
                {nodesByKind.get(kind)?.length ?? 0}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                onClick={() => void onAddNode(kind)}
                disabled={syncing}
                data-testid={`architecture-code-add-${kind}`}
                title={`Add ${kind}`}
              >
                <Plus className="size-3" />
              </Button>
            </header>

            <div className="scrollbar-sleek min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {(nodesByKind.get(kind) ?? []).map((node) => (
                <CodeLevelCard
                  key={node.id}
                  node={node}
                  selected={node.id === selectedNodeId}
                  syncing={syncing}
                  nodeMap={nodeMap}
                  onSelect={() => onSelectNode(node.id)}
                  onDelete={() => void onDeleteNode(node.id)}
                />
              ))}
              {(nodesByKind.get(kind) ?? []).length === 0 ? (
                <div className="rounded border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  No {kind}s yet
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function CodeLevelCard({
  node,
  selected,
  syncing,
  nodeMap,
  onSelect,
  onDelete
}: {
  node: ArchitectureDiagramNode
  selected: boolean
  syncing: boolean
  nodeMap: Map<string, { kind: string; status?: ArchitectureStatus }>
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`group w-full rounded border px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-foreground bg-accent/70 shadow-sm'
          : 'border-border bg-background hover:border-foreground/40'
      }`}
      onClick={onSelect}
      data-testid="architecture-code-card"
      data-node-id={node.id}
    >
      <div className="flex items-center gap-2">
        {node.data.status ? (
          <span
            className={`size-2 shrink-0 rounded-full ${STATUS_DOT[node.data.status] ?? 'bg-muted-foreground'}`}
            title={node.data.status}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">
          {node.data.name}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {node.data.kind}
        </span>
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
          disabled={syncing}
          title="Delete"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      {node.data.description ? (
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          <DescriptionText text={node.data.description} nodeMap={nodeMap} />
        </div>
      ) : null}
      {node.data.kind === 'model' && node.data.properties?.length ? (
        <PropertyList properties={node.data.properties} />
      ) : null}
    </button>
  )
}

function PropertyList({
  properties
}: {
  properties: ArchitectureModelProperty[]
}): React.JSX.Element {
  return (
    <div className="mt-2 space-y-1">
      {properties.map((property) => (
        <div key={property.label} className="flex gap-2 text-[11px] leading-snug">
          <span className="shrink-0 font-mono text-foreground/70">.{property.label}</span>
          <span className="min-w-0 truncate text-muted-foreground">{property.description}</span>
        </div>
      ))}
    </div>
  )
}
