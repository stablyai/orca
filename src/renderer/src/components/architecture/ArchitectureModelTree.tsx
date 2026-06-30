import type React from 'react'
import { Boxes, ChevronRight, Network } from 'lucide-react'
import type {
  ArchitectureDiagramModel,
  ArchitectureDiagramNode
} from './architecture-diagram-types'
import { isExpandableKind } from './architecture-diagram-model'

type ArchitectureModelTreeProps = {
  model: ArchitectureDiagramModel
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  onDrillNode: (nodeId: string) => void
}

export function ArchitectureModelTree({
  model,
  selectedNodeId,
  onSelectNode,
  onDrillNode
}: ArchitectureModelTreeProps): React.JSX.Element {
  const childrenByParent = new Map<string, ArchitectureDiagramNode[]>()
  for (const node of model.nodes) {
    const key = node.parentId ?? ''
    childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), node])
  }
  for (const [key, children] of childrenByParent) {
    childrenByParent.set(
      key,
      [...children].sort((left, right) => left.data.name.localeCompare(right.data.name))
    )
  }

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r border-border bg-background text-xs"
      data-testid="architecture-model-tree"
    >
      <div className="scrollbar-sleek grid gap-2 overflow-y-auto p-2">
        <section className="grid gap-1">
          <div className="flex items-center gap-1.5 px-1 py-1 font-medium text-muted-foreground">
            <Network className="size-3.5" />
            Model tree
          </div>
          {(childrenByParent.get('') ?? []).map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              childrenByParent={childrenByParent}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              onDrillNode={onDrillNode}
            />
          ))}
          {(childrenByParent.get('') ?? []).length === 0 ? (
            <div className="rounded border border-dashed border-border px-2 py-3 text-center text-muted-foreground">
              No nodes
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  )
}

function TreeNode({
  node,
  depth,
  childrenByParent,
  selectedNodeId,
  onSelectNode,
  onDrillNode
}: {
  node: ArchitectureDiagramNode
  depth: number
  childrenByParent: Map<string, ArchitectureDiagramNode[]>
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  onDrillNode: (nodeId: string) => void
}): React.JSX.Element {
  const children = childrenByParent.get(node.id) ?? []
  return (
    <div className="grid gap-0.5">
      <div
        className={`flex items-center gap-1 rounded py-1 pr-2 text-left hover:bg-accent ${
          node.id === selectedNodeId ? 'bg-accent text-foreground' : 'text-muted-foreground'
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => onSelectNode(node.id)}
        data-testid="architecture-tree-node"
        data-node-id={node.id}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => onSelectNode(node.id)}
        >
          {children.length > 0 ? (
            <ChevronRight className="size-3 shrink-0" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{node.data.name}</span>
          <span className="rounded bg-muted px-1 text-[10px]">{node.data.kind}</span>
        </button>
        {(node.data.contract?.expect.length ?? 0) > 0 ? <Boxes className="size-3" /> : null}
        {isExpandableKind(node.data.kind) ? (
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            title="Drill into node"
            onClick={(event) => {
              event.stopPropagation()
              onDrillNode(node.id)
            }}
            data-testid="architecture-tree-drill-node"
          >
            <ChevronRight className="size-3" />
          </button>
        ) : null}
      </div>
      {children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          childrenByParent={childrenByParent}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onDrillNode={onDrillNode}
        />
      ))}
    </div>
  )
}
