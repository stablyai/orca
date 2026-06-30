/* eslint-disable max-lines -- Why: this migration keeps Scryer's groups drag context, palette, and nested cards together so cross-card DnD behavior stays auditable. */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  Box,
  Boxes,
  Code2,
  CornerUpLeft,
  Database,
  Folder,
  GripVertical,
  Network,
  Plus,
  Table2,
  Trash2,
  UserRound,
  Workflow
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  ArchitectureDiagramKind,
  ArchitectureDiagramNode,
  ArchitectureContract,
  ArchitectureContractItem,
  ArchitectureGroup
} from './architecture-diagram-types'
import { Button } from '../ui/button'

type DragItem =
  | { kind: 'group'; id: string }
  | { kind: 'member'; nodeId: string; sourceGroupId: string | null }

type GroupsDndValue = {
  groups: ArchitectureGroup[]
  onNavigateToNode: (id: string) => void
  parentNode: ArchitectureDiagramNode | undefined
  outOfScope: string | null
  visibleGroups: ArchitectureGroup[]
  nodeById: Map<string, ArchitectureDiagramNode>
  childrenOf: Map<string | undefined, ArchitectureGroup[]>
  ungroupedNodes: ArchitectureDiagramNode[]
  active: DragItem | null
  selectedGroupId: string | null
  onSelectedGroupChange: (groupId: string | null) => void
  patchGroup: (id: string, patch: Partial<ArchitectureGroup>) => void
  deleteGroup: (id: string) => void
  createEmptyGroup: () => string
  removeMember: (nodeId: string, sourceGroupId: string) => void
}

export type GroupsDndProviderProps = {
  allNodes: ArchitectureDiagramNode[]
  groups: ArchitectureGroup[]
  onUpdateGroups: (updater: (prev: ArchitectureGroup[]) => ArchitectureGroup[]) => void
  currentParentId: string | undefined
  onNavigateToNode: (id: string) => void
  selectedGroupId?: string | null
  onSelectedGroupChange?: (groupId: string | null) => void
  children: ReactNode
}

const KIND_ICON: Record<ArchitectureDiagramKind, LucideIcon> = {
  person: UserRound,
  system: Network,
  container: Boxes,
  component: Box,
  operation: Code2,
  process: Workflow,
  model: Table2
}

const GroupsDndContext = createContext<GroupsDndValue | null>(null)
const NOOP_SELECTED_GROUP_CHANGE = (): void => {}

function useGroupsDnd(): GroupsDndValue {
  const value = useContext(GroupsDndContext)
  if (!value) {
    throw new Error('GroupsDndContext missing')
  }
  return value
}

function scopeMessage(parent: ArchitectureDiagramNode | undefined): string | null {
  if (!parent) {
    return 'Drill into a system or container to manage its groups.'
  }
  if (parent.data.kind === 'system' || parent.data.kind === 'container') {
    return null
  }
  return 'Groups live at the container and component level. Navigate up to a system or container.'
}

function targetChildKind(
  parent: ArchitectureDiagramNode | undefined
): ArchitectureDiagramKind | null {
  if (parent?.data.kind === 'system') {
    return 'container'
  }
  if (parent?.data.kind === 'container') {
    return 'component'
  }
  return null
}

function createGroupId(): string {
  return `group-${globalThis.crypto.randomUUID()}`
}

export function GroupsDndProvider({
  allNodes,
  groups,
  onUpdateGroups,
  currentParentId,
  onNavigateToNode,
  selectedGroupId = null,
  onSelectedGroupChange = NOOP_SELECTED_GROUP_CHANGE,
  children
}: GroupsDndProviderProps): React.JSX.Element {
  const parentNode = currentParentId
    ? allNodes.find((node) => node.id === currentParentId)
    : undefined
  const outOfScope = scopeMessage(parentNode)
  const childKind = targetChildKind(parentNode)

  const levelChildren = useMemo(
    () =>
      childKind
        ? allNodes.filter(
            (node) => node.parentId === currentParentId && node.data.kind === childKind
          )
        : [],
    [allNodes, childKind, currentParentId]
  )
  const levelChildIds = useMemo(
    () => new Set(levelChildren.map((node) => node.id)),
    [levelChildren]
  )

  const visibleGroups = useMemo(
    () =>
      parentNode
        ? groups.filter(
            (group) =>
              (group.parentNodeId !== undefined
                ? group.parentNodeId === currentParentId
                : group.memberIds.every((memberId) => levelChildIds.has(memberId))) &&
              (group.memberIds.length === 0 ||
                group.memberIds.every((memberId) => levelChildIds.has(memberId)))
          )
        : [],
    [currentParentId, groups, levelChildIds, parentNode]
  )
  const visibleGroupIds = useMemo(
    () => new Set(visibleGroups.map((group) => group.id)),
    [visibleGroups]
  )

  const nodeById = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes])
  const nodeToGroup = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of visibleGroups) {
      for (const memberId of group.memberIds) {
        map.set(memberId, group.id)
      }
    }
    return map
  }, [visibleGroups])

  const childrenOf = useMemo(() => {
    const map = new Map<string | undefined, ArchitectureGroup[]>()
    for (const group of visibleGroups) {
      const key =
        group.parentGroupId && visibleGroupIds.has(group.parentGroupId)
          ? group.parentGroupId
          : undefined
      const list = map.get(key) ?? []
      list.push(group)
      map.set(key, list)
    }
    return map
  }, [visibleGroupIds, visibleGroups])

  const ungroupedNodes = useMemo(
    () => levelChildren.filter((node) => !nodeToGroup.has(node.id)),
    [levelChildren, nodeToGroup]
  )

  const wouldCycle = useCallback(
    (groupId: string, candidateParentId: string): boolean => {
      let cursor: string | undefined = candidateParentId
      const seen = new Set<string>([groupId])
      while (cursor) {
        if (seen.has(cursor)) {
          return true
        }
        seen.add(cursor)
        cursor = groups.find((group) => group.id === cursor)?.parentGroupId
      }
      return false
    },
    [groups]
  )

  const patchGroup = useCallback(
    (id: string, patch: Partial<ArchitectureGroup>) => {
      onUpdateGroups((prev) =>
        prev.map((group) => (group.id === id ? { ...group, ...patch } : group))
      )
    },
    [onUpdateGroups]
  )

  const deleteGroup = useCallback(
    (id: string) => {
      onUpdateGroups((prev) => {
        const deleted = prev.find((group) => group.id === id)
        const newParent = deleted?.parentGroupId
        return prev
          .filter((group) => group.id !== id)
          .map((group) =>
            group.parentGroupId === id ? { ...group, parentGroupId: newParent } : group
          )
      })
      onSelectedGroupChange(selectedGroupId === id ? null : selectedGroupId)
    },
    [onSelectedGroupChange, onUpdateGroups, selectedGroupId]
  )

  const createEmptyGroup = useCallback(() => {
    const id = createGroupId()
    onUpdateGroups((prev) => [
      ...prev,
      { id, name: 'New group', memberIds: [], parentNodeId: parentNode?.id ?? null }
    ])
    return id
  }, [onUpdateGroups, parentNode?.id])

  const moveMember = useCallback(
    (nodeId: string, targetGroupId: string) => {
      onUpdateGroups((prev) =>
        prev.map((group) => {
          const withoutNode = group.memberIds.filter((memberId) => memberId !== nodeId)
          if (group.id !== targetGroupId) {
            return withoutNode.length === group.memberIds.length
              ? group
              : { ...group, memberIds: withoutNode }
          }
          return withoutNode.includes(nodeId)
            ? group
            : { ...group, memberIds: [...withoutNode, nodeId] }
        })
      )
    },
    [onUpdateGroups]
  )

  const removeMember = useCallback(
    (nodeId: string, sourceGroupId: string) => {
      onUpdateGroups((prev) =>
        prev.map((group) =>
          group.id === sourceGroupId
            ? { ...group, memberIds: group.memberIds.filter((memberId) => memberId !== nodeId) }
            : group
        )
      )
    },
    [onUpdateGroups]
  )

  const [active, setActive] = useState<DragItem | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActive((event.active.data.current as DragItem | undefined) ?? null)
  }, [])

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const item = (event.active.data.current as DragItem | undefined) ?? null
      const overId = event.over?.id as string | undefined
      setActive(null)
      if (!item || !overId) {
        return
      }

      if (overId === 'drop-palette') {
        if (item.kind === 'member' && item.sourceGroupId) {
          removeMember(item.nodeId, item.sourceGroupId)
        } else if (item.kind === 'group') {
          patchGroup(item.id, { parentGroupId: undefined })
        }
        return
      }

      if (overId === 'drop-new-group') {
        if (item.kind === 'member') {
          const newId = createGroupId()
          onUpdateGroups((prev) => {
            const cleaned = prev.map((group) => ({
              ...group,
              memberIds: group.memberIds.filter((memberId) => memberId !== item.nodeId)
            }))
            return [
              ...cleaned,
              {
                id: newId,
                name: 'New group',
                memberIds: [item.nodeId],
                parentNodeId: parentNode?.id ?? null
              }
            ]
          })
        }
        return
      }

      if (!overId.startsWith('group:')) {
        return
      }

      const targetGroupId = overId.slice('group:'.length)
      if (item.kind === 'member') {
        moveMember(item.nodeId, targetGroupId)
        return
      }
      if (item.id === targetGroupId || wouldCycle(item.id, targetGroupId)) {
        return
      }
      patchGroup(item.id, { parentGroupId: targetGroupId })
    },
    [moveMember, onUpdateGroups, parentNode?.id, patchGroup, removeMember, wouldCycle]
  )

  const value = useMemo<GroupsDndValue>(
    () => ({
      groups,
      onNavigateToNode,
      parentNode,
      outOfScope,
      visibleGroups,
      nodeById,
      childrenOf,
      ungroupedNodes,
      active,
      selectedGroupId,
      onSelectedGroupChange,
      patchGroup,
      deleteGroup,
      createEmptyGroup,
      removeMember
    }),
    [
      active,
      childrenOf,
      createEmptyGroup,
      deleteGroup,
      groups,
      nodeById,
      onNavigateToNode,
      onSelectedGroupChange,
      outOfScope,
      parentNode,
      patchGroup,
      removeMember,
      selectedGroupId,
      ungroupedNodes,
      visibleGroups
    ]
  )

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <GroupsDndContext.Provider value={value}>{children}</GroupsDndContext.Provider>
      <DragOverlay>
        {active ? <DragGhost item={active} nodeById={nodeById} groups={visibleGroups} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

export function GroupsMain(): React.JSX.Element {
  const {
    parentNode,
    outOfScope,
    childrenOf,
    nodeById,
    active,
    selectedGroupId,
    onSelectedGroupChange,
    patchGroup,
    deleteGroup,
    createEmptyGroup,
    onNavigateToNode,
    removeMember
  } = useGroupsDnd()

  if (outOfScope) {
    return (
      <div
        className="flex flex-1 items-center justify-center bg-[var(--surface)] px-8 text-center text-sm text-muted-foreground"
        data-testid="architecture-groups-main"
      >
        {outOfScope}
      </div>
    )
  }

  const memberLabel = parentNode?.data.kind === 'system' ? 'containers' : 'components'
  const topLevelGroups = childrenOf.get(undefined) ?? []

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface)]"
      data-testid="architecture-groups-main"
    >
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-6 py-8">
          <header>
            <h1 className="text-lg font-semibold text-[var(--text)]">Groups</h1>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-tertiary)]">
              Organize {memberLabel} that share a deployment unit, package, or ownership boundary.
            </p>
          </header>

          <div className="space-y-3">
            {topLevelGroups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                childrenOf={childrenOf}
                nodeById={nodeById}
                depth={0}
                active={active}
                selectedGroupId={selectedGroupId}
                onSelectGroup={onSelectedGroupChange}
                onPatch={patchGroup}
                onDelete={deleteGroup}
                onNavigate={onNavigateToNode}
                onRemoveMember={removeMember}
              />
            ))}
            <NewGroupDrop active={active} onCreateEmpty={createEmptyGroup} />
          </div>
        </div>
      </div>
    </div>
  )
}

export function GroupsPalette(): React.JSX.Element {
  const { outOfScope, ungroupedNodes, active, onNavigateToNode } = useGroupsDnd()

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="architecture-groups-palette"
    >
      <div className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Available
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
          Drag into a group. Drop here to remove from a group.
        </p>
      </div>
      {outOfScope ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] italic text-[var(--text-muted)]">
          {outOfScope}
        </div>
      ) : (
        <PaletteDropArea active={active}>
          {ungroupedNodes.length === 0 ? (
            <div className="px-1 py-2 text-[11px] italic text-[var(--text-muted)]">
              Everything at this level is grouped.
            </div>
          ) : (
            <ul className="space-y-1">
              {ungroupedNodes.map((node) => (
                <PaletteItem key={node.id} node={node} onNavigate={onNavigateToNode} />
              ))}
            </ul>
          )}
        </PaletteDropArea>
      )}
    </div>
  )
}

function GroupCard({
  group,
  childrenOf,
  nodeById,
  depth,
  active,
  selectedGroupId,
  onSelectGroup,
  onPatch,
  onDelete,
  onNavigate,
  onRemoveMember
}: {
  group: ArchitectureGroup
  childrenOf: Map<string | undefined, ArchitectureGroup[]>
  nodeById: Map<string, ArchitectureDiagramNode>
  depth: number
  active: DragItem | null
  selectedGroupId: string | null
  onSelectGroup: (groupId: string | null) => void
  onPatch: (id: string, patch: Partial<ArchitectureGroup>) => void
  onDelete: (id: string) => void
  onNavigate: (id: string) => void
  onRemoveMember: (nodeId: string, sourceGroupId: string) => void
}): React.JSX.Element {
  const dropId = `group:${group.id}`
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging
  } = useDraggable({
    id: `drag-${dropId}`,
    data: { kind: 'group', id: group.id } satisfies DragItem
  })
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: dropId })
  const children = childrenOf.get(group.id) ?? []
  const selected = selectedGroupId === group.id
  const memberNodes = group.memberIds
    .map((memberId) => nodeById.get(memberId))
    .filter((node): node is ArchitectureDiagramNode => !!node)
  const showDropCue = !!active && !(active.kind === 'group' && active.id === group.id)

  return (
    <div
      ref={setDropRef}
      style={{ marginLeft: depth > 0 ? 16 : 0 }}
      className={`rounded-lg border transition-colors ${
        selected
          ? 'border-emerald-500 bg-emerald-500/8 ring-1 ring-emerald-500/60'
          : isOver && showDropCue
            ? 'border-[var(--text)] bg-[var(--surface-active)]/40 ring-1 ring-[var(--text)]'
            : 'border-[var(--border)] bg-[var(--surface-tint)]/20'
      } ${isDragging ? 'opacity-40' : ''}`}
      data-testid="architecture-group-card"
      data-group-id={group.id}
      data-selected={selected ? 'true' : 'false'}
      onClick={(event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, button')) {
          return
        }
        event.stopPropagation()
        onSelectGroup(group.id)
      }}
    >
      <div
        ref={setDragRef}
        className="group/hdr flex items-start gap-2 border-b border-[var(--border-subtle)] p-3"
      >
        <button
          type="button"
          className="mt-0.5 cursor-grab touch-none text-[var(--text-muted)] hover:text-[var(--text)] active:cursor-grabbing"
          {...listeners}
          {...attributes}
          aria-label="Drag group"
          title="Drag to nest inside another group"
          data-testid="architecture-group-drag-handle"
        >
          <GripVertical size={14} />
        </button>
        <Folder size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
        <div className="min-w-0 flex-1">
          <input
            className="w-full bg-transparent text-sm font-semibold text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
            value={group.name}
            placeholder="ArchitectureGroup name"
            onChange={(event) => onPatch(group.id, { name: event.currentTarget.value })}
            data-testid="architecture-group-name"
          />
          <textarea
            ref={(element) => {
              if (!element) {
                return
              }
              element.style.height = 'auto'
              element.style.height = `${element.scrollHeight}px`
            }}
            className="w-full resize-none bg-transparent text-xs leading-relaxed text-[var(--text-tertiary)] outline-none placeholder:text-[var(--text-ghost)]"
            rows={1}
            value={group.description ?? ''}
            placeholder="What does this group represent?"
            onChange={(event) => {
              event.currentTarget.style.height = 'auto'
              event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`
              onPatch(group.id, { description: event.currentTarget.value || undefined })
            }}
          />
          <GroupContractEditor
            contract={group.contract}
            onChange={(contract) => onPatch(group.id, { contract })}
          />
        </div>
        {depth > 0 ? (
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text)] group-hover/hdr:opacity-100"
            title="Move to top level"
            onClick={() => onPatch(group.id, { parentGroupId: undefined })}
          >
            <CornerUpLeft size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-red-100 hover:text-red-500 group-hover/hdr:opacity-100 dark:hover:bg-red-900/30"
          title="Delete group"
          onClick={() => onDelete(group.id)}
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="min-h-8 space-y-1 p-2">
        {memberNodes.length === 0 && children.length === 0 ? (
          <div className="px-2 py-1 text-[11px] italic text-[var(--text-muted)]">
            Drop nodes here.
          </div>
        ) : null}
        {memberNodes.map((node) => (
          <MemberChip
            key={node.id}
            node={node}
            groupId={group.id}
            onNavigate={onNavigate}
            onRemove={() => onRemoveMember(node.id, group.id)}
          />
        ))}
      </div>

      {children.length > 0 ? (
        <div className="space-y-2 px-2 pb-2">
          {children.map((child) => (
            <GroupCard
              key={child.id}
              group={child}
              childrenOf={childrenOf}
              nodeById={nodeById}
              depth={depth + 1}
              active={active}
              selectedGroupId={selectedGroupId}
              onSelectGroup={onSelectGroup}
              onPatch={onPatch}
              onDelete={onDelete}
              onNavigate={onNavigate}
              onRemoveMember={onRemoveMember}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function GroupContractEditor({
  contract,
  onChange
}: {
  contract: ArchitectureContract | undefined
  onChange: (contract: ArchitectureContract) => void
}): React.JSX.Element {
  const normalized = normalizeContract(contract)
  return (
    <div className="mt-2 grid gap-1.5" data-testid="architecture-group-contract">
      {(['expect', 'ask', 'never'] as const).map((key) => (
        <label key={key} className="grid gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {key}
          </span>
          <textarea
            className="min-h-8 resize-y rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1 text-[11px] leading-relaxed text-[var(--text-secondary)] outline-none focus:border-[var(--border)]"
            value={contractItemsToText(normalized[key])}
            placeholder={`One ${key} rule per line`}
            onChange={(event) =>
              onChange({ ...normalized, [key]: textToContractItems(event.currentTarget.value) })
            }
            data-testid={`architecture-group-contract-${key}`}
          />
        </label>
      ))}
    </div>
  )
}

function normalizeContract(contract: ArchitectureContract | undefined): ArchitectureContract {
  return {
    expect: contract?.expect ?? [],
    ask: contract?.ask ?? [],
    never: contract?.never ?? []
  }
}

function contractItemToText(item: ArchitectureContractItem): string {
  return typeof item === 'string' ? item : item.text
}

function contractItemsToText(items: ArchitectureContractItem[]): string {
  return items.map(contractItemToText).join('\n')
}

function textToContractItems(text: string): ArchitectureContractItem[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function MemberChip({
  node,
  groupId,
  onNavigate,
  onRemove
}: {
  node: ArchitectureDiagramNode
  groupId: string
  onNavigate: (id: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const Icon = KIND_ICON[node.data.kind] ?? Box
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `member:${groupId}:${node.id}`,
    data: { kind: 'member', nodeId: node.id, sourceGroupId: groupId } satisfies DragItem
  })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`group/member flex touch-none cursor-grab items-center gap-2 rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1 transition-colors hover:border-[var(--border)] active:cursor-grabbing ${
        isDragging ? 'opacity-40' : ''
      }`}
      data-node-id={node.id}
    >
      <GripVertical size={12} className="shrink-0 text-[var(--text-muted)]" />
      <Icon size={12} className="shrink-0 text-[var(--text-muted)]" />
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm text-[var(--text-secondary)] hover:text-[var(--text)]"
        onClick={() => onNavigate(node.id)}
        title="Navigate to node"
      >
        {node.data.name}
      </button>
      <button
        type="button"
        className="cursor-pointer px-1 text-xs text-[var(--text-muted)] opacity-0 transition-opacity hover:text-red-500 group-hover/member:opacity-100"
        title="Remove from group"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        data-testid="architecture-group-member-remove"
      >
        x
      </button>
    </div>
  )
}

function PaletteItem({
  node,
  onNavigate
}: {
  node: ArchitectureDiagramNode
  onNavigate: (id: string) => void
}): React.JSX.Element {
  const Icon = KIND_ICON[node.data.kind] ?? Box
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${node.id}`,
    data: { kind: 'member', nodeId: node.id, sourceGroupId: null } satisfies DragItem
  })
  return (
    <li
      ref={setNodeRef}
      className={`flex touch-none cursor-grab items-center gap-2 rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1 transition-colors hover:border-[var(--border)] active:cursor-grabbing ${
        isDragging ? 'opacity-40' : ''
      }`}
      {...listeners}
      {...attributes}
      data-testid="architecture-groups-palette-item"
      data-node-id={node.id}
    >
      <GripVertical size={10} className="shrink-0 text-[var(--text-muted)]" />
      <Icon size={12} className="shrink-0 text-[var(--text-muted)]" />
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-[var(--text-secondary)] hover:text-[var(--text)]"
        onClick={() => onNavigate(node.id)}
        title="Navigate to node"
      >
        {node.data.name}
      </button>
    </li>
  )
}

function PaletteDropArea({
  active,
  children
}: {
  active: DragItem | null
  children: ReactNode
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: 'drop-palette' })
  const acceptsDrop =
    (active?.kind === 'member' && active.sourceGroupId !== null) || active?.kind === 'group'
  return (
    <div
      ref={setNodeRef}
      className={`scrollbar-sleek flex-1 overflow-y-auto px-3 py-3 transition-colors ${
        acceptsDrop && isOver ? 'bg-[var(--surface-active)]/60' : ''
      }`}
    >
      {children}
      {acceptsDrop ? (
        <div
          className={`mt-2 rounded border border-dashed py-2 text-center text-[11px] transition-colors ${
            isOver
              ? 'border-[var(--text)] text-[var(--text)]'
              : 'border-[var(--border)] text-[var(--text-muted)]'
          }`}
        >
          {active?.kind === 'group' ? 'Drop to move to top level' : 'Drop to remove from group'}
        </div>
      ) : null}
    </div>
  )
}

function NewGroupDrop({
  active,
  onCreateEmpty
}: {
  active: DragItem | null
  onCreateEmpty: () => void
}): React.JSX.Element | null {
  const { setNodeRef, isOver } = useDroppable({ id: 'drop-new-group' })
  const acceptsDrop = active?.kind === 'member'
  if (active && !acceptsDrop) {
    return null
  }
  if (!active) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full border-dashed"
        onClick={() => onCreateEmpty()}
        data-testid="architecture-group-create"
      >
        <Plus className="size-3" />
        New group
      </Button>
    )
  }
  return (
    <div
      ref={setNodeRef}
      className={`rounded border border-dashed py-2 text-center text-xs transition-colors ${
        isOver
          ? 'border-[var(--text)] bg-[var(--surface-active)] text-[var(--text)]'
          : 'border-[var(--border)] text-[var(--text-muted)]'
      }`}
    >
      Drop to create a new group
    </div>
  )
}

function DragGhost({
  item,
  nodeById,
  groups
}: {
  item: DragItem
  nodeById: Map<string, ArchitectureDiagramNode>
  groups: ArchitectureGroup[]
}): React.JSX.Element {
  if (item.kind === 'group') {
    const group = groups.find((candidate) => candidate.id === item.id)
    return (
      <div className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface-overlay)] px-2 py-1 text-sm font-semibold text-[var(--text)] shadow-md">
        <Folder size={14} className="text-[var(--text-muted)]" />
        {group?.name ?? 'ArchitectureGroup'}
      </div>
    )
  }
  const node = nodeById.get(item.nodeId)
  const Icon = node ? (KIND_ICON[node.data.kind] ?? Box) : Database
  return (
    <div className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface-overlay)] px-2 py-1 text-sm text-[var(--text-secondary)] shadow-md">
      <Icon size={12} className="text-[var(--text-muted)]" />
      {node?.data.name ?? 'Node'}
    </div>
  )
}
