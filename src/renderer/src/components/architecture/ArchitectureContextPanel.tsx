/* eslint-disable max-lines -- Why: the Scryer context panel is intentionally kept together while the remaining node/edge context pieces are still being migrated. */
import { Boxes, Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ArchitectureDiagramLink,
  ArchitectureDiagramModel,
  ArchitectureDiagramNode,
  ArchitectureDiagramShape,
  ArchitectureContract,
  ArchitectureContractItem,
  ArchitectureGroup,
  ArchitectureModelProperty,
  ArchitectureSourceLocation,
  ArchitectureStatus
} from './architecture-diagram-types'
import { Button } from '../ui/button'
import { GroupsPalette } from './GroupsView'
import { getNodeContextForModel } from './architecture-diagram-model'
import {
  contractItemText as getContractItemText,
  getVerifiedBlockers,
  normalizeContractItem,
  setContractItemPassed
} from './contract-status'
import { MentionTextarea, type MentionItem } from './nodes/MentionTextarea'

const STATUS_OPTIONS: ArchitectureStatus[] = ['proposed', 'implemented', 'verified', 'vagrant']
const SHAPE_OPTIONS: ArchitectureDiagramShape[] = [
  'rectangle',
  'person',
  'cylinder',
  'pipe',
  'trapezoid',
  'bucket',
  'hexagon'
]
const INSPECTOR_PANEL_CLASS =
  'flex w-80 shrink-0 flex-col border-l border-border bg-background text-sm xl:w-96'

type ArchitectureContextPanelProps = {
  model: ArchitectureDiagramModel | null
  selectedNode: ArchitectureDiagramNode | null
  selectedEdge: ArchitectureDiagramLink | null
  selectedGroup: ArchitectureGroup | null
  multiSelectedNodeIds: string[]
  totalSelected: number
  canGroupSelection: boolean
  targetNodeId: string
  sourcePattern: string
  syncing: boolean
  onAddNode: () => void | Promise<void>
  onSave: () => void | Promise<void>
  onDeleteNode: () => void | Promise<void>
  onDeleteEdge: () => void | Promise<void>
  onUpdateNodeDraft: (nodeId: string, patch: Partial<ArchitectureDiagramNode['data']>) => void
  onUpdateNode: (patch: Partial<ArchitectureDiagramNode['data']>) => void | Promise<void>
  onPersistNodeById: (
    nodeId: string,
    patch: Partial<ArchitectureDiagramNode['data']>
  ) => void | Promise<void>
  onUpdateEdge: (patch: { label?: string; method?: string }) => void | Promise<void>
  onSourcePatternChange: (pattern: string) => void
  onSaveSourcePattern: (pattern: string) => void | Promise<void>
  onSaveSourceLocations: (
    nodeId: string,
    locations: ArchitectureSourceLocation[]
  ) => void | Promise<void>
  onTargetNodeChange: (nodeId: string) => void
  onSelectEdge: (edgeId: string) => void
  onAddEdge: (sourceNodeId: string, targetNodeId: string) => void | Promise<void>
  onCreateGroupFromSelection: (name: string) => void | Promise<void>
  onAddSelectionToGroup: (groupId: string) => void | Promise<void>
  onUpdateGroup: (patch: Partial<ArchitectureGroup>) => void | Promise<void>
  onDeleteGroup: () => void | Promise<void>
  onRemoveGroupMember: (nodeId: string) => void | Promise<void>
  groupsPaletteMode?: boolean
  nodeDiff?: ArchitectureDiagramNode['data']
  onDismissNodeDiff?: (nodeId: string) => void
}

export function ArchitectureContextPanel({
  model,
  selectedNode,
  selectedEdge,
  selectedGroup,
  multiSelectedNodeIds,
  totalSelected,
  canGroupSelection,
  targetNodeId,
  sourcePattern,
  syncing,
  onAddNode,
  onSave,
  onDeleteNode,
  onDeleteEdge,
  onUpdateNodeDraft,
  onUpdateNode,
  onPersistNodeById,
  onUpdateEdge,
  onSourcePatternChange,
  onSaveSourcePattern,
  onSaveSourceLocations,
  onTargetNodeChange,
  onSelectEdge,
  onAddEdge,
  onCreateGroupFromSelection,
  onAddSelectionToGroup,
  onUpdateGroup,
  onDeleteGroup,
  onRemoveGroupMember,
  groupsPaletteMode = false,
  nodeDiff,
  onDismissNodeDiff
}: ArchitectureContextPanelProps): React.JSX.Element {
  if (multiSelectedNodeIds.length >= 2 && model) {
    return (
      <aside className={INSPECTOR_PANEL_CLASS}>
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-3">
          <MultiSelectionPanel
            selectedIds={multiSelectedNodeIds}
            totalSelected={totalSelected}
            groups={model.groups ?? []}
            canGroup={canGroupSelection}
            syncing={syncing}
            onCreateGroup={onCreateGroupFromSelection}
            onAddToGroup={onAddSelectionToGroup}
          />
        </div>
      </aside>
    )
  }

  if (groupsPaletteMode && !selectedGroup) {
    return (
      <aside className={INSPECTOR_PANEL_CLASS}>
        <GroupsPalette />
      </aside>
    )
  }

  return (
    <aside className={INSPECTOR_PANEL_CLASS}>
      <div className="flex gap-2 border-b border-border p-3">
        <Button
          className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
          size="sm"
          onClick={() => void onAddNode()}
          data-testid="architecture-add-node"
          disabled={syncing}
        >
          <Plus className="size-3.5" />
          Add Node
        </Button>
        <Button variant="outline" size="icon-sm" onClick={() => void onSave()} disabled={syncing}>
          <Save className="size-3.5" />
        </Button>
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-3">
        {selectedGroup && model ? (
          <GroupEditor
            group={selectedGroup}
            model={model}
            syncing={syncing}
            onUpdateGroup={onUpdateGroup}
            onDeleteGroup={onDeleteGroup}
            onRemoveGroupMember={onRemoveGroupMember}
          />
        ) : selectedNode && model ? (
          <NodeEditor
            node={selectedNode}
            model={model}
            targetNodeId={targetNodeId}
            sourcePattern={sourcePattern}
            syncing={syncing}
            onUpdateNodeDraft={onUpdateNodeDraft}
            onUpdateNode={onUpdateNode}
            onPersistNodeById={onPersistNodeById}
            onSourcePatternChange={onSourcePatternChange}
            onSaveSourcePattern={onSaveSourcePattern}
            onSaveSourceLocations={onSaveSourceLocations}
            onTargetNodeChange={onTargetNodeChange}
            onSelectEdge={onSelectEdge}
            onAddEdge={onAddEdge}
            onDeleteNode={onDeleteNode}
            nodeDiff={nodeDiff}
            onDismissNodeDiff={onDismissNodeDiff}
          />
        ) : selectedEdge && model ? (
          <EdgeEditor
            edge={selectedEdge}
            model={model}
            syncing={syncing}
            onUpdateEdge={onUpdateEdge}
            onDeleteEdge={onDeleteEdge}
          />
        ) : (
          <div className="rounded border border-border p-3 text-xs text-muted-foreground">
            {model?.nodes.length
              ? 'Select a node, relationship, or group to edit it.'
              : 'Add a node to start the architecture model.'}
          </div>
        )}
      </div>
    </aside>
  )
}

function MultiSelectionPanel({
  selectedIds,
  totalSelected,
  groups,
  canGroup,
  syncing,
  onCreateGroup,
  onAddToGroup
}: {
  selectedIds: string[]
  totalSelected: number
  groups: ArchitectureGroup[]
  canGroup: boolean
  syncing: boolean
  onCreateGroup: (name: string) => void | Promise<void>
  onAddToGroup: (groupId: string) => void | Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('New group')
  return (
    <div className="grid gap-3" data-testid="architecture-multi-selection-panel">
      <PanelTitle title="Selection" />
      <div className="rounded border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        {selectedIds.length} groupable node{selectedIds.length === 1 ? '' : 's'} selected
        {totalSelected !== selectedIds.length ? ` from ${totalSelected} selected items` : ''}
      </div>
      {canGroup ? (
        <>
          <section className="grid gap-2">
            <PanelTitle title="Create group" />
            <input
              className="rounded border border-border bg-background px-2 py-1"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim()) {
                  void onCreateGroup(name.trim())
                  setName('New group')
                }
              }}
              data-testid="architecture-multi-group-name"
              disabled={syncing}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (name.trim()) {
                  void onCreateGroup(name.trim())
                  setName('New group')
                }
              }}
              disabled={syncing || !name.trim()}
              data-testid="architecture-multi-create-group"
            >
              <Plus className="size-3.5" />
              Create group
            </Button>
          </section>
          {groups.length > 0 ? (
            <section className="grid gap-2 border-t border-border pt-3">
              <PanelTitle title="Add to existing" />
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="flex items-center gap-2 rounded border border-border px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => void onAddToGroup(group.id)}
                  data-testid="architecture-multi-add-existing"
                  disabled={syncing}
                >
                  <Boxes className="size-3" />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  <span>{group.memberIds.length}</span>
                </button>
              ))}
            </section>
          ) : null}
        </>
      ) : (
        <div className="rounded border border-border p-3 text-xs text-muted-foreground">
          Drill into a system or container to group selected nodes.
        </div>
      )}
    </div>
  )
}

function GroupEditor({
  group,
  model,
  syncing,
  onUpdateGroup,
  onDeleteGroup,
  onRemoveGroupMember
}: {
  group: ArchitectureGroup
  model: ArchitectureDiagramModel
  syncing: boolean
  onUpdateGroup: (patch: Partial<ArchitectureGroup>) => void | Promise<void>
  onDeleteGroup: () => void | Promise<void>
  onRemoveGroupMember: (nodeId: string) => void | Promise<void>
}): React.JSX.Element {
  const memberNodes = group.memberIds
    .map((memberId) => model.nodes.find((node) => node.id === memberId))
    .filter((node): node is ArchitectureDiagramNode => !!node)
  return (
    <div className="grid gap-4" data-testid="architecture-selected-group-editor">
      <section className="grid gap-3">
        <PanelTitle title="ArchitectureGroup" />
        <ReadOnlyField label="id" value={group.id} />
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            value={group.name}
            onChange={(event) => void onUpdateGroup({ name: event.currentTarget.value })}
            data-testid="architecture-selected-group-name"
            disabled={syncing}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Description</span>
          <textarea
            className="min-h-20 rounded border border-border bg-background px-2 py-1"
            value={group.description ?? ''}
            onChange={(event) =>
              void onUpdateGroup({ description: event.currentTarget.value || undefined })
            }
            data-testid="architecture-selected-group-description"
            disabled={syncing}
          />
        </label>
      </section>

      <GroupContractEditor
        contract={group.contract}
        syncing={syncing}
        onChange={(contract) => void onUpdateGroup({ contract })}
      />

      <section className="grid gap-2 border-t border-border pt-3">
        <PanelTitle title="Members" />
        {memberNodes.length === 0 ? (
          <div className="rounded border border-border p-2 text-xs text-muted-foreground">
            This group has no members.
          </div>
        ) : (
          memberNodes.map((node) => (
            <div
              key={node.id}
              className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">{node.data.name}</span>
              <span className="text-muted-foreground">{node.data.kind}</span>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => void onRemoveGroupMember(node.id)}
                disabled={syncing}
                data-testid="architecture-selected-group-member-remove"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))
        )}
      </section>

      <Button
        variant="outline"
        size="sm"
        className="border-destructive/40 text-destructive hover:text-destructive"
        onClick={() => void onDeleteGroup()}
        disabled={syncing}
        data-testid="architecture-selected-group-delete"
      >
        <Trash2 className="size-3.5" />
        Delete group
      </Button>
    </div>
  )
}

function EdgeEditor({
  edge,
  model,
  syncing,
  onUpdateEdge,
  onDeleteEdge
}: {
  edge: ArchitectureDiagramLink
  model: ArchitectureDiagramModel
  syncing: boolean
  onUpdateEdge: (patch: { label?: string; method?: string }) => void | Promise<void>
  onDeleteEdge: () => void | Promise<void>
}): React.JSX.Element {
  const source = model.nodes.find((node) => node.id === edge.source)
  const target = model.nodes.find((node) => node.id === edge.target)
  const label = edge.data?.label ?? ''
  const method = edge.data?.method ?? ''

  return (
    <div className="grid gap-3" data-testid="architecture-edge-editor">
      <PanelTitle title="Relationship" />
      <ReadOnlyField label="id" value={edge.id} />
      <ReadOnlyField label="source" value={source?.data.name ?? edge.source} />
      <ReadOnlyField label="target" value={target?.data.name ?? edge.target} />
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Label</span>
        <input
          className="rounded border border-border bg-background px-2 py-1"
          value={label}
          onChange={(event) => void onUpdateEdge({ label: event.currentTarget.value })}
          placeholder="reads from"
          data-testid="architecture-edge-label-input"
          disabled={syncing}
        />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Method</span>
        <input
          className="rounded border border-border bg-background px-2 py-1"
          value={method}
          onChange={(event) => void onUpdateEdge({ method: event.currentTarget.value })}
          placeholder="REST/JSON"
          data-testid="architecture-edge-method-input"
          disabled={syncing}
        />
      </label>
      <Button
        variant="outline"
        size="sm"
        className="border-destructive/40 text-destructive hover:text-destructive"
        onClick={() => void onDeleteEdge()}
        disabled={syncing}
        data-testid="architecture-edge-delete"
      >
        <Trash2 className="size-3.5" />
        Delete relationship
      </Button>
    </div>
  )
}

function NodeEditor({
  node,
  model,
  targetNodeId,
  sourcePattern,
  syncing,
  onUpdateNodeDraft,
  onUpdateNode,
  onPersistNodeById,
  onSourcePatternChange,
  onSaveSourcePattern,
  onSaveSourceLocations,
  onTargetNodeChange,
  onSelectEdge,
  onAddEdge,
  onDeleteNode,
  nodeDiff,
  onDismissNodeDiff
}: {
  node: ArchitectureDiagramNode
  model: ArchitectureDiagramModel
  targetNodeId: string
  sourcePattern: string
  syncing: boolean
  onUpdateNodeDraft: (nodeId: string, patch: Partial<ArchitectureDiagramNode['data']>) => void
  onUpdateNode: (patch: Partial<ArchitectureDiagramNode['data']>) => void | Promise<void>
  onPersistNodeById: (
    nodeId: string,
    patch: Partial<ArchitectureDiagramNode['data']>
  ) => void | Promise<void>
  onSourcePatternChange: (pattern: string) => void
  onSaveSourcePattern: (pattern: string) => void | Promise<void>
  onSaveSourceLocations: (
    nodeId: string,
    locations: ArchitectureSourceLocation[]
  ) => void | Promise<void>
  onTargetNodeChange: (nodeId: string) => void
  onSelectEdge: (edgeId: string) => void
  onAddEdge: (sourceNodeId: string, targetNodeId: string) => void | Promise<void>
  onDeleteNode: () => void | Promise<void>
  nodeDiff?: ArchitectureDiagramNode['data']
  onDismissNodeDiff?: (nodeId: string) => void
}): React.JSX.Element {
  const context = useMemo(() => getNodeContextForModel(model, node.id), [model, node.id])
  const [sourceRows, setSourceRows] = useState<ArchitectureSourceLocation[]>([])
  const [sourceRowsDirty, setSourceRowsDirty] = useState(false)
  const sourceRowsNodeIdRef = useRef(node.id)
  const [propertyRows, setPropertyRows] = useState<ArchitectureModelProperty[]>([])
  const [propertyRowsDirty, setPropertyRowsDirty] = useState(false)
  const propertyRowsNodeIdRef = useRef(node.id)
  const propertyRowsRef = useRef<HTMLDivElement | null>(null)
  const edgeTargetSelectRef = useRef<HTMLSelectElement | null>(null)
  const edgeTargetIdRef = useRef(targetNodeId)
  const skipAddEdgeClickRef = useRef(false)
  const [statusDraft, setStatusDraft] = useState<ArchitectureStatus | ''>(node.data.status ?? '')
  const [statusReason, setStatusReason] = useState('')
  const nodeSourceLocations = useMemo(
    () => [
      ...(model.sourceMap?.[node.id] ?? []),
      ...(model.boundaries?.[node.id]?.map((source) => ({
        pattern: source.pattern,
        ...(source.comment ? { command: source.comment } : {})
      })) ?? [])
    ],
    [model.boundaries, model.sourceMap, node.id]
  )
  const nodeProperties = useMemo(() => node.data.properties ?? [], [node.data.properties])
  const verifiedBlockers = useMemo(() => getVerifiedBlockers(model, node.id), [model, node.id])
  const mentionItems = useMemo(() => buildMentionItems(model, node), [model, node])
  const mentionWarnings = useMemo(() => getMentionEdgeWarnings(model, node), [model, node])
  const showTechnology = node.data.kind === 'container' || node.data.kind === 'component'
  const showExternal = node.data.kind === 'system'
  const showShape =
    node.data.kind !== 'person' &&
    node.data.kind !== 'operation' &&
    node.data.kind !== 'process' &&
    node.data.kind !== 'model'
  const showContract =
    node.data.kind !== 'person' && !node.data.external && node.data.kind !== 'model'
  const statusChanged = statusDraft !== (node.data.status ?? '')
  const statusReasonRequired = statusChanged && !!statusDraft
  const verifiedBlocked = statusDraft === 'verified' && verifiedBlockers.length > 0
  const nodeEdges = model.links.filter((edge) => edge.source === node.id || edge.target === node.id)
  const addRelationship = () => {
    void onAddEdge(node.id, edgeTargetIdRef.current || edgeTargetSelectRef.current?.value || '')
  }

  useEffect(() => {
    setStatusDraft(node.data.status ?? '')
    setStatusReason('')
  }, [node.data.status, node.id])

  useEffect(() => {
    edgeTargetIdRef.current = targetNodeId
  }, [targetNodeId])

  useEffect(() => {
    if (sourceRowsNodeIdRef.current !== node.id) {
      sourceRowsNodeIdRef.current = node.id
      setSourceRows(nodeSourceLocations)
      setSourceRowsDirty(false)
      return
    }

    if (!sourceRowsDirty) {
      setSourceRows(nodeSourceLocations)
    }
  }, [node.id, nodeSourceLocations, sourceRowsDirty])

  useEffect(() => {
    if (propertyRowsNodeIdRef.current !== node.id) {
      propertyRowsNodeIdRef.current = node.id
      setPropertyRows(nodeProperties)
      setPropertyRowsDirty(false)
      return
    }

    if (!propertyRowsDirty) {
      setPropertyRows(nodeProperties)
    }
  }, [node.id, nodeProperties, propertyRowsDirty])

  const updateSourceRows = (
    updater: (rows: ArchitectureSourceLocation[]) => ArchitectureSourceLocation[]
  ): void => {
    setSourceRows((rows) => updater(rows))
    setSourceRowsDirty(true)
  }

  const normalizePropertyRows = (rows: ArchitectureModelProperty[]): ArchitectureModelProperty[] =>
    rows
      .map((property) => ({
        label: property.label.trim(),
        description: property.description.trim()
      }))
      .filter((property) => property.label)

  const updatePropertyRows = (
    updater: (rows: ArchitectureModelProperty[]) => ArchitectureModelProperty[]
  ): void => {
    setPropertyRows((rows) => {
      const nextRows = updater(rows)
      void onPersistNodeById(node.id, {
        properties:
          normalizePropertyRows(nextRows).length > 0 ? normalizePropertyRows(nextRows) : undefined
      })
      return nextRows
    })
    setPropertyRowsDirty(true)
  }

  const saveSourceRows = async (): Promise<void> => {
    const locations = sourceRows
      .map((location) => ({
        ...location,
        pattern: location.pattern.trim(),
        command: location.command?.trim() || undefined
      }))
      .filter((location) => location.pattern)

    await onSaveSourceLocations(node.id, locations)
    setSourceRows(locations)
    setSourceRowsDirty(false)
  }

  const saveModelProperties = async (): Promise<void> => {
    const propertiesFromDom = propertyRowsRef.current
      ? [...propertyRowsRef.current.querySelectorAll<HTMLElement>('[data-property-row]')]
          .map((row) => {
            const inputs = row.querySelectorAll<HTMLInputElement>('input')
            return {
              label: inputs[0]?.value.trim() ?? '',
              description: inputs[1]?.value.trim() ?? ''
            }
          })
          .filter((property) => property.label)
      : []
    const properties = normalizePropertyRows(
      propertiesFromDom.length > 0 ? propertiesFromDom : propertyRows
    )

    await onPersistNodeById(node.id, { properties: properties.length > 0 ? properties : undefined })
    setPropertyRows(properties)
    setPropertyRowsDirty(false)
  }

  return (
    <div className="grid gap-4">
      {nodeDiff ? (
        <NodeDiffPanel
          previous={nodeDiff}
          current={node.data}
          onDismiss={() => onDismissNodeDiff?.(node.id)}
        />
      ) : null}
      <section className="grid gap-3">
        <PanelTitle title="Node" />
        <ReadOnlyField label="id" value={node.id} />
        <ReadOnlyField label="kind" value={node.data.kind} />
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            value={node.data.name}
            onChange={(event) => onUpdateNodeDraft(node.id, { name: event.currentTarget.value })}
            onBlur={(event) => void onUpdateNode({ name: event.currentTarget.value })}
            data-testid="architecture-node-name"
            disabled={syncing}
          />
        </label>

        {showTechnology ? (
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">
              {node.data.kind === 'component' ? 'Implements' : 'Technology'}
            </span>
            <input
              className="rounded border border-border bg-background px-2 py-1"
              value={node.data.technology ?? ''}
              onChange={(event) =>
                onUpdateNodeDraft(node.id, { technology: event.currentTarget.value || undefined })
              }
              onBlur={(event) =>
                void onUpdateNode({ technology: event.currentTarget.value || undefined })
              }
              placeholder={node.data.kind === 'component' ? 'AuthService' : 'Node.js'}
              disabled={syncing}
            />
          </label>
        ) : null}

        {showExternal ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={!!node.data.external}
              onChange={(event) =>
                void onUpdateNode({
                  external: event.currentTarget.checked || undefined,
                  status: event.currentTarget.checked ? undefined : node.data.status
                })
              }
              disabled={syncing}
            />
            External system
          </label>
        ) : null}

        {showShape ? (
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Shape</span>
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={node.data.shape ?? ''}
              onChange={(event) =>
                void onUpdateNode({
                  shape: event.currentTarget.value
                    ? (event.currentTarget.value as ArchitectureDiagramShape)
                    : undefined
                })
              }
              disabled={syncing}
              data-testid="architecture-node-shape-select"
            >
              <option value="">default</option>
              {SHAPE_OPTIONS.map((shape) => (
                <option key={shape} value={shape}>
                  {shape}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Description</span>
          <MentionTextarea
            className="min-h-20 rounded border border-border bg-background px-2 py-1"
            value={node.data.description}
            onChange={(event) => onUpdateNodeDraft(node.id, { description: event })}
            mentionNames={mentionItems}
            rows={4}
            testId="architecture-node-description"
            disabled={syncing}
            onBlur={(value) => void onUpdateNode({ description: value })}
          />
        </label>
        {mentionWarnings.length > 0 ? (
          <div
            className="rounded border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="architecture-mention-warning"
          >
            {mentionWarnings.join('; ')}
          </div>
        ) : null}

        {node.data.kind === 'model' ? (
          <div
            className="grid gap-2 rounded border border-border p-2"
            data-testid="architecture-model-properties"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">Properties</span>
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  updatePropertyRows((rows) => [...rows, { label: '', description: '' }])
                }
                disabled={syncing}
                data-testid="architecture-model-property-add"
              >
                <Plus className="size-3" />
                Add
              </Button>
            </div>
            <div ref={propertyRowsRef} className="grid gap-2">
              {propertyRows.map((property, index) => (
                <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2" data-property-row>
                  <input
                    className="rounded border border-border bg-background px-2 py-1 font-mono"
                    defaultValue={property.label}
                    placeholder="id"
                    onChange={() => setPropertyRowsDirty(true)}
                    disabled={syncing}
                    data-testid="architecture-model-property-label"
                    onBlur={() => {
                      if (propertyRowsDirty) {
                        void saveModelProperties()
                      }
                    }}
                  />
                  <input
                    className="rounded border border-border bg-background px-2 py-1"
                    defaultValue={property.description}
                    placeholder="Unique task id"
                    onChange={() => setPropertyRowsDirty(true)}
                    disabled={syncing}
                    data-testid="architecture-model-property-description"
                    onBlur={() => {
                      if (propertyRowsDirty) {
                        void saveModelProperties()
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() =>
                      updatePropertyRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))
                    }
                    disabled={syncing}
                    data-testid="architecture-model-property-delete"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
            {propertyRows.length === 0 ? (
              <div className="rounded border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground">
                No properties yet
              </div>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveModelProperties()}
              disabled={syncing || !propertyRowsDirty}
              data-testid="architecture-model-property-save"
            >
              <Save className="size-3" />
              Save properties
            </Button>
          </div>
        ) : null}

        {node.data.kind !== 'person' && !node.data.external ? (
          <div className="grid gap-2">
            <span className="text-xs text-muted-foreground">ArchitectureStatus</span>
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={statusDraft}
              onChange={(event) =>
                setStatusDraft(event.currentTarget.value as ArchitectureStatus | '')
              }
              disabled={syncing}
              data-testid="architecture-node-status"
            >
              <option value="">none</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            {statusChanged ? (
              <>
                <input
                  className="rounded border border-border bg-background px-2 py-1"
                  value={statusReason}
                  onChange={(event) => setStatusReason(event.currentTarget.value)}
                  placeholder="Reason for status change"
                  disabled={syncing}
                  data-testid="architecture-node-status-reason"
                />
                {verifiedBlocked ? (
                  <div
                    className="rounded border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-700 dark:text-amber-300"
                    data-testid="architecture-node-verified-blockers"
                  >
                    Pass these expect items before verifying: {verifiedBlockers.join('; ')}
                  </div>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void onUpdateNode({
                      status: statusDraft || undefined,
                      statusReason: statusDraft ? statusReason.trim() : undefined
                    })
                  }
                  disabled={
                    syncing ||
                    !statusChanged ||
                    verifiedBlocked ||
                    (statusReasonRequired && !statusReason.trim())
                  }
                  data-testid="architecture-node-status-save"
                >
                  Save status
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="grid gap-3 border-t border-border pt-3">
        <PanelTitle title="Source Map" />
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Source pattern</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            value={sourcePattern}
            onChange={(event) => onSourcePatternChange(event.currentTarget.value)}
            onBlur={(event) => void onSaveSourcePattern(event.currentTarget.value)}
            placeholder="src/**/*.ts"
            data-testid="architecture-source-pattern"
            disabled={syncing}
          />
        </label>
        <div className="grid gap-2">
          {sourceRows.map((location, index) => (
            <div key={index} className="grid gap-1 rounded border border-border p-2">
              <input
                className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                value={location.pattern}
                placeholder="src/**/*.ts"
                onChange={(event) => {
                  const value = event.currentTarget.value
                  updateSourceRows((rows) =>
                    rows.map((row, rowIndex) =>
                      rowIndex === index ? { ...row, pattern: value } : row
                    )
                  )
                }}
                data-testid="architecture-source-pattern-row"
                disabled={syncing}
              />
              <div className="grid grid-cols-3 gap-1">
                <input
                  className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                  value={location.line ?? ''}
                  placeholder="line"
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    updateSourceRows((rows) =>
                      rows.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, line: numberOrUndefined(value) } : row
                      )
                    )
                  }}
                  data-testid="architecture-source-line-row"
                  disabled={syncing}
                />
                <input
                  className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                  value={location.endLine ?? ''}
                  placeholder="end"
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    updateSourceRows((rows) =>
                      rows.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, endLine: numberOrUndefined(value) } : row
                      )
                    )
                  }}
                  data-testid="architecture-source-end-line-row"
                  disabled={syncing}
                />
                <input
                  className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                  value={location.command ?? ''}
                  placeholder="command"
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    updateSourceRows((rows) =>
                      rows.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, command: value || undefined } : row
                      )
                    )
                  }}
                  data-testid="architecture-source-command-row"
                  disabled={syncing}
                />
              </div>
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  updateSourceRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))
                }
                disabled={syncing}
              >
                Remove source
              </Button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => updateSourceRows((rows) => [...rows, { pattern: '' }])}
            disabled={syncing}
            data-testid="architecture-source-add"
          >
            <Plus className="size-3" />
            Add source
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void saveSourceRows()}
            disabled={syncing}
            data-testid="architecture-source-save"
          >
            Save sources
          </Button>
        </div>
      </section>

      <section className="grid gap-3 border-t border-border pt-3">
        <PanelTitle title="Relationships" />
        <div className="flex gap-2">
          <select
            ref={edgeTargetSelectRef}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
            value={targetNodeId}
            onChange={(event) => {
              edgeTargetIdRef.current = event.currentTarget.value
              onTargetNodeChange(event.currentTarget.value)
            }}
            data-testid="architecture-edge-target"
            disabled={syncing}
          >
            <option value="">Select target</option>
            {model.nodes
              .filter((candidate) => candidate.id !== node.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.data.name}
                </option>
              ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onPointerDown={(event) => {
              if (event.pointerType !== 'mouse') {
                return
              }
              skipAddEdgeClickRef.current = true
              event.preventDefault()
              addRelationship()
            }}
            onClick={() => {
              if (skipAddEdgeClickRef.current) {
                skipAddEdgeClickRef.current = false
                return
              }
              addRelationship()
            }}
            disabled={syncing}
            data-testid="architecture-add-edge"
          >
            Add
          </Button>
        </div>
        {nodeEdges.length > 0 ? (
          <div className="grid gap-1">
            {nodeEdges.map((edge) => {
              const source = model.nodes.find((candidate) => candidate.id === edge.source)
              const target = model.nodes.find((candidate) => candidate.id === edge.target)
              return (
                <button
                  key={edge.id}
                  type="button"
                  className="min-w-0 rounded border border-border px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onSelectEdge(edge.id)}
                  disabled={syncing}
                  data-testid="architecture-existing-edge"
                >
                  <span className="font-medium text-foreground/80">
                    {source?.data.name ?? edge.source}
                    {' -> '}
                    {target?.data.name ?? edge.target}
                  </span>
                  {edge.data?.label ? <span> - {edge.data.label}</span> : null}
                  {edge.data?.method ? <span> [{edge.data.method}]</span> : null}
                </button>
              )
            })}
          </div>
        ) : null}
      </section>

      <NotesEditor
        notes={node.data.notes ?? []}
        syncing={syncing}
        onChange={(notes) => void onUpdateNode({ notes: notes.length ? notes : undefined })}
      />

      {showContract ? (
        <ContractEditor
          contract={node.data.contract}
          syncing={syncing}
          onChange={(contract) => void onUpdateNode({ contract })}
        />
      ) : null}

      <NodeContextSummary context={context} />

      <Button
        variant="outline"
        size="sm"
        className="border-destructive/40 text-destructive hover:text-destructive"
        onClick={() => void onDeleteNode()}
        disabled={syncing}
        data-testid="architecture-node-delete"
      >
        <Trash2 className="size-3.5" />
        Delete node
      </Button>
    </div>
  )
}

function NotesEditor({
  notes,
  syncing,
  onChange
}: {
  notes: string[]
  syncing: boolean
  onChange: (notes: string[]) => void
}): React.JSX.Element {
  return (
    <section className="grid gap-2 border-t border-border pt-3">
      <PanelTitle title="Notes" />
      {notes.map((note, index) => (
        <div key={index} className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
            value={note}
            onChange={(event) =>
              onChange(
                notes.map((item, itemIndex) =>
                  itemIndex === index ? event.currentTarget.value : item
                )
              )
            }
            disabled={syncing}
          />
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onChange(notes.filter((_, itemIndex) => itemIndex !== index))}
            disabled={syncing}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...notes, ''])}
        disabled={syncing}
      >
        <Plus className="size-3.5" />
        Add note
      </Button>
    </section>
  )
}

function NodeDiffPanel({
  previous,
  current,
  onDismiss
}: {
  previous: ArchitectureDiagramNode['data']
  current: ArchitectureDiagramNode['data']
  onDismiss: () => void
}): React.JSX.Element {
  const rows = [
    ['name', previous.name, current.name],
    ['status', previous.status ?? '', current.status ?? ''],
    ['technology', previous.technology ?? '', current.technology ?? ''],
    ['description', previous.description ?? '', current.description ?? '']
  ].filter(([, before, after]) => before !== after)

  if (rows.length === 0) {
    return (
      <section
        className="grid gap-2 rounded border border-violet-400/30 bg-violet-400/10 p-3 text-xs"
        data-testid="architecture-node-diff"
      >
        <div className="flex items-center justify-between gap-2">
          <PanelTitle title="External Change" />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
          >
            dismiss
          </button>
        </div>
        <div className="text-muted-foreground">This node changed outside the panel.</div>
      </section>
    )
  }

  return (
    <section
      className="grid gap-2 rounded border border-violet-400/30 bg-violet-400/10 p-3 text-xs"
      data-testid="architecture-node-diff"
    >
      <div className="flex items-center justify-between gap-2">
        <PanelTitle title="External Change" />
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          data-testid="architecture-node-diff-dismiss"
        >
          dismiss
        </button>
      </div>
      {rows.map(([label, before, after]) => (
        <div key={label} className="grid gap-1 rounded border border-border bg-background/70 p-2">
          <div className="font-medium text-foreground/80">{label}</div>
          <div className="line-through opacity-70">{before || '(empty)'}</div>
          <div>{after || '(empty)'}</div>
        </div>
      ))}
    </section>
  )
}

function ContractEditor({
  contract,
  syncing,
  onChange
}: {
  contract: ArchitectureContract | undefined
  syncing: boolean
  onChange: (contract: ArchitectureContract) => void
}): React.JSX.Element {
  const incoming = useMemo(() => normalizeContract(contract), [contract])
  const [draft, setDraft] = useState<ArchitectureContract>(incoming)
  const draftRef = useRef<ArchitectureContract>(incoming)
  const pendingDraftKeyRef = useRef<string | null>(null)
  const incomingKey = JSON.stringify(incoming)

  useEffect(() => {
    if (pendingDraftKeyRef.current && pendingDraftKeyRef.current !== incomingKey) {
      return
    }
    draftRef.current = incoming
    setDraft(incoming)
    if (pendingDraftKeyRef.current === incomingKey) {
      pendingDraftKeyRef.current = null
    }
  }, [incoming, incomingKey])

  const commitDraft = (next: ArchitectureContract): void => {
    draftRef.current = next
    setDraft(next)
    pendingDraftKeyRef.current = JSON.stringify(next)
    onChange(next)
  }

  const updateItems = (
    key: keyof ArchitectureContract,
    updater: (items: ArchitectureContractItem[]) => ArchitectureContractItem[]
  ): void => {
    const current = draftRef.current
    commitDraft({ ...current, [key]: updater(current[key]) })
  }

  return (
    <section className="grid gap-3 border-t border-border pt-3">
      <PanelTitle title="Contract" />
      {(['expect', 'ask', 'never'] as const).map((key) => (
        <ContractList
          key={key}
          label={key}
          items={draft[key]}
          syncing={syncing}
          onChange={(updater) => updateItems(key, updater)}
        />
      ))}
    </section>
  )
}

function GroupContractEditor({
  contract,
  syncing,
  onChange
}: {
  contract: ArchitectureContract | undefined
  syncing: boolean
  onChange: (contract: ArchitectureContract) => void
}): React.JSX.Element {
  const normalized = normalizeContract(contract)
  return (
    <section className="grid gap-3 border-t border-border pt-3">
      <PanelTitle title="Contract" />
      {(['expect', 'ask', 'never'] as const).map((key) => (
        <label key={key} className="grid gap-1">
          <span className="text-xs text-muted-foreground">{key}</span>
          <textarea
            className="min-h-16 resize-y rounded border border-border bg-background px-2 py-1 text-xs"
            value={contractItemsToText(normalized[key])}
            onChange={(event) =>
              onChange({ ...normalized, [key]: textToContractItems(event.currentTarget.value) })
            }
            data-testid={`architecture-selected-group-contract-${key}`}
            disabled={syncing}
          />
        </label>
      ))}
    </section>
  )
}

function ContractList({
  label,
  items,
  syncing,
  onChange
}: {
  label: keyof ArchitectureContract
  items: ArchitectureContractItem[]
  syncing: boolean
  onChange: (updater: (items: ArchitectureContractItem[]) => ArchitectureContractItem[]) => void
}): React.JSX.Element {
  const readUrlFromRow = (element: Element): string | undefined => {
    const row = element.closest('[data-contract-item-row]')
    return row?.querySelector<HTMLInputElement>('[data-contract-field="url"]')?.value
  }

  return (
    <div className="grid gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {items.map((item, index) => (
        <div
          key={index}
          className="grid gap-2 rounded border border-border p-2"
          data-contract-item-row
        >
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
              value={getContractItemText(item)}
              onChange={(event) =>
                onChange((currentItems) =>
                  currentItems.map((current, itemIndex) =>
                    itemIndex === index
                      ? updateContractItemText(current, event.currentTarget.value)
                      : current
                  )
                )
              }
              disabled={syncing}
              data-testid={`architecture-contract-${label}-text`}
            />
            <select
              className="w-28 rounded border border-border bg-background px-2 py-1 text-xs"
              value={String(normalizeContractItem(item).passed)}
              onChange={(event) =>
                onChange((currentItems) =>
                  currentItems.map((current, itemIndex) =>
                    itemIndex === index
                      ? setContractItemPassed(
                          updateContractItemUrl(
                            current,
                            readUrlFromRow(event.currentTarget) ??
                              normalizeContractItem(current).url ??
                              ''
                          ),
                          event.currentTarget.value === 'undefined'
                            ? undefined
                            : event.currentTarget.value === 'true'
                        )
                      : current
                  )
                )
              }
              disabled={syncing}
              data-testid={`architecture-contract-${label}-passed`}
            >
              <option value="undefined">unchecked</option>
              <option value="true">passed</option>
              <option value="false">failed</option>
            </select>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() =>
                onChange((currentItems) =>
                  currentItems.filter((_, itemIndex) => itemIndex !== index)
                )
              }
              disabled={syncing}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
          <input
            className="rounded border border-border bg-background px-2 py-1 text-xs"
            value={normalizeContractItem(item).url ?? ''}
            placeholder="Evidence URL"
            onChange={(event) =>
              onChange((currentItems) =>
                currentItems.map((current, itemIndex) =>
                  itemIndex === index
                    ? updateContractItemUrl(current, event.currentTarget.value)
                    : current
                )
              )
            }
            disabled={syncing}
            data-testid={`architecture-contract-${label}-url`}
            data-contract-field="url"
          />
          <input
            className="text-xs text-muted-foreground"
            type="file"
            accept="image/*"
            disabled={syncing}
            data-testid={`architecture-contract-${label}-image`}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (!file) {
                return
              }
              const url = readUrlFromRow(event.currentTarget)
              const reader = new FileReader()
              reader.onload = () => {
                const dataUrl = typeof reader.result === 'string' ? reader.result : ''
                const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
                onChange((currentItems) =>
                  currentItems.map((current, itemIndex) =>
                    itemIndex === index
                      ? updateContractItemImage(
                          updateContractItemUrl(
                            current,
                            url ?? normalizeContractItem(current).url ?? ''
                          ),
                          {
                            filename: file.name,
                            mimeType: file.type,
                            data: base64
                          }
                        )
                      : current
                  )
                )
              }
              reader.readAsDataURL(file)
            }}
          />
          {normalizeContractItem(item).image ? (
            <div className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {normalizeContractItem(item).image?.filename}
              </span>
              <Button
                variant="outline"
                size="icon-xs"
                onClick={() =>
                  onChange((currentItems) =>
                    currentItems.map((current, itemIndex) =>
                      itemIndex === index ? updateContractItemImage(current, undefined) : current
                    )
                  )
                }
                disabled={syncing}
                data-testid={`architecture-contract-${label}-image-clear`}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange((currentItems) => [...currentItems, ''])}
        disabled={syncing}
      >
        <Plus className="size-3.5" />
        Add {label}
      </Button>
    </div>
  )
}

function NodeContextSummary({
  context
}: {
  context: ReturnType<typeof getNodeContextForModel>
}): React.JSX.Element {
  return (
    <section className="grid gap-2 border-t border-border pt-3 text-xs">
      <PanelTitle title="get_node Context" />
      <ContextLine label="descendants" value={context.descendants.length.toString()} />
      <ContextLine label="internal edges" value={context.internalEdges.length.toString()} />
      <ContextLine label="external edges" value={context.externalEdges.length.toString()} />
      <ContextLine label="source maps" value={Object.keys(context.sourceMap).length.toString()} />
      {context.groups.length ? (
        <div className="flex flex-wrap gap-1">
          {context.groups.map((group) => (
            <span
              key={group.id}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-muted-foreground"
            >
              <Boxes className="size-3" />
              {group.name}
            </span>
          ))}
        </div>
      ) : null}
      {context.externalEdges.map((edge) => (
        <div key={edge.id} className="rounded border border-border px-2 py-1 text-muted-foreground">
          {edge.direction === 'out' ? 'out' : 'in'}: {edge.externalNodeName}
          {edge.data?.label ? ` - ${edge.data.label}` : ''}
        </div>
      ))}
    </section>
  )
}

function PanelTitle({ title }: { title: string }): React.JSX.Element {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
  )
}

function ReadOnlyField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <code className="truncate rounded border border-border bg-muted px-2 py-1 text-xs">
        {value}
      </code>
    </div>
  )
}

function ContextLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3 text-muted-foreground">
      <span>{label}</span>
      <span>{value}</span>
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

function contractItemText(item: ArchitectureContractItem): string {
  return getContractItemText(item)
}

function updateContractItemText(
  item: ArchitectureContractItem,
  text: string
): ArchitectureContractItem {
  const normalized = normalizeContractItem(item)
  if (!normalized.passed && !normalized.url && !normalized.image) {
    return text
  }
  return { ...normalized, text }
}

function updateContractItemUrl(
  item: ArchitectureContractItem,
  url: string
): ArchitectureContractItem {
  const normalized = normalizeContractItem(item)
  const nextUrl = url.trim() || undefined
  if (!normalized.passed && !nextUrl && !normalized.image) {
    return normalized.text
  }
  return { ...normalized, url: nextUrl }
}

function updateContractItemImage(
  item: ArchitectureContractItem,
  image: ReturnType<typeof normalizeContractItem>['image'] | undefined
): ArchitectureContractItem {
  const normalized = normalizeContractItem(item)
  if (!normalized.passed && !normalized.url && !image) {
    return normalized.text
  }
  return { ...normalized, image }
}

function contractItemsToText(items: ArchitectureContractItem[]): string {
  return items.map(contractItemText).join('\n')
}

function textToContractItems(text: string): ArchitectureContractItem[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function numberOrUndefined(value: string): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function buildMentionItems(
  model: ArchitectureDiagramModel,
  node: ArchitectureDiagramNode
): MentionItem[] {
  return model.nodes
    .filter((candidate) => candidate.id !== node.id && candidate.parentId === node.parentId)
    .map((candidate) => ({
      name: candidate.data.name,
      insertValue: candidate.data.name,
      kind: candidate.data.kind,
      status: candidate.data.status
    }))
}

function getMentionEdgeWarnings(
  model: ArchitectureDiagramModel,
  node: ArchitectureDiagramNode
): string[] {
  const siblings = model.nodes.filter(
    (candidate) => candidate.id !== node.id && candidate.parentId === node.parentId
  )
  const edgeKeys = new Set<string>()
  for (const edge of model.links) {
    edgeKeys.add(`${edge.source}->${edge.target}`)
    edgeKeys.add(`${edge.target}->${edge.source}`)
  }
  const warnings: string[] = []
  for (const match of node.data.description.matchAll(/@\[([^\]]+)\]/g)) {
    const rawName = match[1]
    const target = siblings.find(
      (candidate) =>
        candidate.id === rawName ||
        candidate.data.name === rawName ||
        candidate.data.name.toLowerCase() === rawName.toLowerCase()
    )
    if (!target) {
      warnings.push(`Mention ${rawName} does not match a sibling node`)
      continue
    }
    if (!edgeKeys.has(`${node.id}->${target.id}`)) {
      warnings.push(`Mention ${target.data.name} needs a relationship edge`)
    }
  }
  return warnings
}
