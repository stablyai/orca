/* eslint-disable max-lines -- Why: this panel still composes the migrated C4 canvas, flow, group, sync, and inspector surfaces while controller logic now lives in useArchitectureModelController. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Bot, Boxes, Command, Network, Plug, Plus, Redo2, RefreshCw, Undo2 } from 'lucide-react'
import type { ArchitectureWorkspace } from '../../../../shared/types'
import { Button } from '../ui/button'
import { ArchitectureCanvas } from './ArchitectureCanvas'
import { ArchitectureCommandPalette } from './ArchitectureCommandPalette'
import { ArchitectureContextPanel } from './ArchitectureContextPanel'
import { ArchitectureModelTree } from './ArchitectureModelTree'
import { ArchitectureSectionBoundary } from './ArchitectureSectionBoundary'
import { ArchitectureThemeEditor } from './ArchitectureThemeEditor'
import { CodeLevelRack } from './CodeLevelRack'
import { GroupsDndProvider, GroupsMain } from './GroupsView'
import { SyncBar } from './SyncBar'
import {
  type ArchitectureMode,
  useArchitectureModelController
} from './useArchitectureModelController'
import {
  createScryerThemeStyle,
  normalizeScryerTheme,
  type ScryerThemeSettings
} from '../../../../shared/scryer/theme'
import { recordArchitecturePerformanceMetric } from './architecture-performance'

const ARCHITECTURE_THEME_STORAGE_KEY = 'orca-scryer:architecture-theme'

function readArchitectureTheme(): ScryerThemeSettings {
  try {
    const raw = window.localStorage.getItem(ARCHITECTURE_THEME_STORAGE_KEY)
    return normalizeScryerTheme(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeScryerTheme(null)
  }
}

function resolveArchitectureThemeDark(theme: ScryerThemeSettings): boolean {
  if (theme.mode === 'dark') {
    return true
  }
  if (theme.mode === 'light') {
    return false
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function modeButtonClass(activeMode: ArchitectureMode, mode: ArchitectureMode): string {
  return `inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium transition-colors ${
    activeMode === mode
      ? 'bg-accent text-foreground'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
  }`
}

export default function ArchitecturePanel({
  workspace
}: {
  workspace: ArchitectureWorkspace
}): React.JSX.Element {
  const renderStartedAtRef = useRef(performance.now())
  renderStartedAtRef.current = performance.now()
  const {
    projectPath,
    model,
    activeModelName,
    projectModels,
    templates,
    architectureMode,
    setArchitectureMode,
    selectedNode,
    selectedEdge,
    selectedGroup,
    selectedNodeId,
    selectedEdgeId,
    selectedGroupId,
    setSelectedGroupId,
    multiSelectedNodeIds,
    totalSelected,
    expandedPath,
    setExpandedPath,
    currentParent,
    currentParentId,
    currentParentKind,
    canShowGroups,
    canGroupMultiSelection,
    targetNodeId,
    setTargetNodeId,
    sourcePattern,
    setSourcePattern,
    drift,
    implementing,
    syncStatus,
    syncMessage,
    syncLog,
    completionGate,
    activeAgent,
    editingLocked,
    canUndo,
    canRedo,
    driftedNodeIds,
    codeLevelNodes,
    message,
    error,
    changedNodeIds,
    nodeDiffs,
    followExternalChanges,
    setFollowExternalChanges,
    loadModel,
    refreshProjectModels,
    createBlankProjectModel,
    createModelFromTemplate,
    openProjectModel,
    saveCurrentModelAs,
    deleteProjectModelByName,
    persist,
    applyModelChange,
    undoModelChange,
    redoModelChange,
    addNode,
    addNodeAtCurrentLevel,
    updateSelectedNode,
    persistNodePatchById,
    updateSelectedNodeDraft,
    selectNode,
    selectEdge,
    selectManyNodes,
    updateSelectedEdge,
    saveSourcePattern,
    saveSourceLocations,
    addEdge,
    deleteSelected,
    deleteSelectedEdge,
    deleteEdgeById,
    addCodeLevelNode,
    deleteNodeById,
    runDriftCheck,
    markSynced,
    navigateToNode,
    drillIntoNode,
    updateGroups,
    createGroupFromSelection,
    addSelectionToGroup,
    patchSelectedGroup,
    removeSelectedGroupMember,
    deleteSelectedGroup,
    toggleLock,
    openSourceLocation,
    startInitialModel,
    fillNodeWithAi,
    startAdvisorReview,
    writeMcpConfig,
    startSync,
    cancelSync,
    finishSync,
    dismissSyncMessage,
    dismissNodeDiff
  } = useArchitectureModelController({ workspace })
  const [commandOpen, setCommandOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [architectureTheme, setArchitectureTheme] = useState(readArchitectureTheme)
  const architectureThemeStyle = useMemo(() => {
    const style = createScryerThemeStyle(
      architectureTheme,
      resolveArchitectureThemeDark(architectureTheme)
    )
    return {
      ...style,
      '--scryer-node-bg': 'var(--architecture-node-fill)',
      '--scryer-outline-stroke': 'var(--architecture-node-border)',
      '--grid-color': 'color-mix(in srgb, var(--architecture-role-muted) 34%, transparent)',
      backgroundColor: 'var(--architecture-role-background)',
      color: 'var(--architecture-role-foreground)'
    } as React.CSSProperties
  }, [architectureTheme])

  useEffect(() => {
    recordArchitecturePerformanceMetric('render', performance.now() - renderStartedAtRef.current)
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(ARCHITECTURE_THEME_STORAGE_KEY, JSON.stringify(architectureTheme))
    } catch {
      // Local storage may be unavailable in constrained windows; the live state still applies.
    }
  }, [architectureTheme])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') {
        return
      }
      event.preventDefault()
      void refreshProjectModels()
      setCommandOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [refreshProjectModels])

  const showBuildWithAi =
    architectureMode === 'topology' && !!model && model.nodes.length === 0 && !!projectPath

  const mainContent = error ? (
    <div className="flex-1 p-4 text-sm text-destructive" data-testid="architecture-error">
      {error}
    </div>
  ) : model ? (
    architectureMode === 'groups' ? (
      <GroupsMain />
    ) : currentParentKind === 'component' && currentParentId ? (
      <CodeLevelRack
        nodes={codeLevelNodes}
        selectedNodeId={selectedNodeId}
        syncing={editingLocked}
        parentName={currentParent?.data.name ?? currentParentId}
        onNavigateUp={() => {
          setExpandedPath((path) => path.slice(0, -1))
          selectNode(currentParentId)
        }}
        onSelectNode={(nodeId) => {
          setArchitectureMode('topology')
          selectNode(nodeId)
        }}
        onAddNode={addCodeLevelNode}
        onDeleteNode={deleteNodeById}
      />
    ) : (
      <ArchitectureCanvas
        model={model}
        syncing={editingLocked}
        expandedPath={expandedPath}
        selectedNodeId={selectedNodeId}
        selectedEdgeId={selectedEdgeId}
        multiSelectedNodeIds={multiSelectedNodeIds}
        changedNodeIds={changedNodeIds}
        driftedNodeIds={driftedNodeIds}
        onExpandedPathChange={setExpandedPath}
        onSelectedNodeChange={selectNode}
        onSelectedEdgeChange={selectEdge}
        onMultiSelectionChange={selectManyNodes}
        onModelChange={applyModelChange}
        onAddNode={addNodeAtCurrentLevel}
        onAddEdge={addEdge}
        onDeleteNode={deleteNodeById}
        onDeleteEdge={deleteEdgeById}
        onOpenSourceLocation={openSourceLocation}
        onFillNodeWithAi={fillNodeWithAi}
        onCreateGroupFromSelection={createGroupFromSelection}
        onAddSelectionToGroup={addSelectionToGroup}
      />
    )
  ) : (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Loading architecture model...
    </div>
  )

  const mainSection = (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="scrollbar-sleek flex h-10 min-w-0 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b border-border px-3">
        <Network className="size-4 text-emerald-500" />
        <span className="truncate text-sm font-medium">{workspace.title}</span>
        <span
          className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          data-testid="architecture-active-model"
        >
          {activeModelName}.scry
        </span>
        {model?.validationWarnings?.length ? (
          <span
            className="min-w-0 flex-1 truncate text-xs text-amber-600 dark:text-amber-300"
            data-testid="architecture-model-warning"
            title={model.validationWarnings.map((warning) => warning.message).join('\n')}
          >
            {model.validationWarnings.length} model warning
            {model.validationWarnings.length === 1 ? '' : 's'}:{' '}
            {model.validationWarnings[0].message}
          </span>
        ) : message ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{message}</span>
        ) : (
          <span className="flex-1" />
        )}
        <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1 py-0.5">
          <button
            type="button"
            className={modeButtonClass(architectureMode, 'topology')}
            aria-pressed={architectureMode === 'topology'}
            onClick={() => setArchitectureMode('topology')}
            data-testid="architecture-mode-topology"
          >
            <Network className="size-3" />
            Topology
          </button>
          {canShowGroups || architectureMode === 'groups' ? (
            <button
              type="button"
              className={modeButtonClass(architectureMode, 'groups')}
              aria-pressed={architectureMode === 'groups'}
              disabled={!canShowGroups}
              onClick={() => canShowGroups && setArchitectureMode('groups')}
              title={
                canShowGroups ? 'Organize this level into groups' : 'Drill into a system first'
              }
              data-testid="architecture-mode-groups"
            >
              <Boxes className="size-3" />
              Groups
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1 py-0.5">
          <button
            type="button"
            className="inline-flex h-7 items-center rounded px-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void undoModelChange()}
            disabled={!canUndo || editingLocked}
            title="Undo model change"
            data-testid="architecture-undo"
          >
            <Undo2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center rounded px-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void redoModelChange()}
            disabled={!canRedo || editingLocked}
            title="Redo model change"
            data-testid="architecture-redo"
          >
            <Redo2 className="size-3.5" />
          </button>
        </div>
        <label
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
          title="Automatically navigate to the level changed by MCP or an agent"
        >
          <input
            type="checkbox"
            checked={followExternalChanges}
            onChange={(event) => setFollowExternalChanges(event.currentTarget.checked)}
            data-testid="architecture-follow-external"
          />
          Follow
        </label>
        <Button variant="outline" size="xs" onClick={() => void loadModel()}>
          <RefreshCw className="size-3" />
          Reload
        </Button>
        <ArchitectureThemeEditor
          open={themeOpen}
          theme={architectureTheme}
          onOpenChange={setThemeOpen}
          onThemeChange={setArchitectureTheme}
        />
        <Button
          variant="outline"
          size="xs"
          onClick={() => void startAdvisorReview()}
          disabled={!projectPath || !model || model.nodes.length === 0 || editingLocked}
          data-testid="architecture-advisor-review"
        >
          <Bot className="size-3" />
          Review
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => void writeMcpConfig()}
          disabled={!projectPath}
          data-testid="architecture-mcp-config"
        >
          <Plug className="size-3" />
          MCP
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            void refreshProjectModels()
            setCommandOpen(true)
          }}
          data-testid="architecture-command-open"
        >
          <Command className="size-3" />
          Cmd
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ArchitectureSectionBoundary
          name="Architecture workspace"
          resetKey={`${activeModelName}:${architectureMode}:${currentParentId ?? ''}`}
        >
          {mainContent}
        </ArchitectureSectionBoundary>
        {showBuildWithAi ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/40">
            <div className="pointer-events-auto grid w-[380px] gap-2 rounded border border-border bg-background p-4 shadow-lg">
              <div className="grid gap-1 border-b border-border pb-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  New project
                </div>
                <div className="truncate text-sm font-semibold text-foreground">
                  {activeModelName}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{projectPath}</div>
              </div>
              <button
                type="button"
                className="flex items-center gap-3 rounded border border-border px-3 py-2 text-left hover:bg-accent"
                onClick={() => void startInitialModel()}
                disabled={editingLocked}
                data-testid="architecture-build-ai"
              >
                <Bot className="size-4 text-violet-500" />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">Build with AI</span>
                  <span className="text-[11px] text-muted-foreground">
                    Scan the codebase and generate an architecture model
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="flex items-center gap-3 rounded border border-border px-3 py-2 text-left hover:bg-accent"
                onClick={() => void createBlankProjectModel(activeModelName)}
                disabled={editingLocked}
                data-testid="architecture-start-blank"
              >
                <Plus className="size-4 text-muted-foreground" />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">Start blank</span>
                  <span className="text-[11px] text-muted-foreground">
                    Add systems, containers, and components manually
                  </span>
                </span>
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <SyncBar
        activeAgent={activeAgent}
        driftedNodes={drift?.nodes ?? []}
        structureChanged={drift?.structureChanged ?? false}
        implementing={implementing}
        syncStatus={syncStatus}
        syncMessage={syncMessage}
        syncLog={syncLog}
        completionGate={completionGate}
        projectPath={projectPath ?? undefined}
        onSync={startSync}
        onCancelSync={cancelSync}
        onFinishSync={finishSync}
        onCheckDrift={runDriftCheck}
        onDismissMessage={dismissSyncMessage}
        onDismissDrift={markSynced}
        onToggleLock={toggleLock}
        onNavigateToNode={navigateToNode}
      />
    </section>
  )

  const contextPanel = (
    <ArchitectureSectionBoundary
      name="Architecture inspector"
      resetKey={`${activeModelName}:${selectedNodeId ?? ''}:${selectedEdgeId ?? ''}:${selectedGroupId ?? ''}`}
    >
      <ArchitectureContextPanel
        model={model}
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        selectedGroup={selectedGroup}
        multiSelectedNodeIds={multiSelectedNodeIds}
        totalSelected={totalSelected}
        canGroupSelection={canGroupMultiSelection}
        targetNodeId={targetNodeId}
        sourcePattern={sourcePattern}
        syncing={editingLocked}
        onAddNode={addNode}
        onSave={() => {
          if (model) {
            return persist(model, 'Saved architecture model')
          }
          return undefined
        }}
        onDeleteNode={deleteSelected}
        onDeleteEdge={deleteSelectedEdge}
        onUpdateNodeDraft={updateSelectedNodeDraft}
        onUpdateNode={updateSelectedNode}
        onPersistNodeById={persistNodePatchById}
        onUpdateEdge={updateSelectedEdge}
        onSourcePatternChange={setSourcePattern}
        onSaveSourcePattern={saveSourcePattern}
        onSaveSourceLocations={saveSourceLocations}
        onTargetNodeChange={setTargetNodeId}
        onSelectEdge={selectEdge}
        onAddEdge={addEdge}
        onCreateGroupFromSelection={createGroupFromSelection}
        onAddSelectionToGroup={addSelectionToGroup}
        onUpdateGroup={patchSelectedGroup}
        onDeleteGroup={deleteSelectedGroup}
        onRemoveGroupMember={removeSelectedGroupMember}
        groupsPaletteMode={architectureMode === 'groups' && !!model}
        nodeDiff={selectedNode ? nodeDiffs.get(selectedNode.id) : undefined}
        onDismissNodeDiff={dismissNodeDiff}
      />
    </ArchitectureSectionBoundary>
  )

  const modelTree = model ? (
    <ArchitectureSectionBoundary name="Architecture tree" resetKey={activeModelName}>
      <ArchitectureModelTree
        model={model}
        selectedNodeId={selectedNodeId}
        onSelectNode={(nodeId) => {
          setArchitectureMode('topology')
          navigateToNode(nodeId)
        }}
        onDrillNode={drillIntoNode}
      />
    </ArchitectureSectionBoundary>
  ) : null

  const panelContent =
    architectureMode === 'groups' && model ? (
      <GroupsDndProvider
        allNodes={model.nodes}
        groups={model.groups ?? []}
        onUpdateGroups={updateGroups}
        currentParentId={currentParentId}
        onNavigateToNode={navigateToNode}
        selectedGroupId={selectedGroupId}
        onSelectedGroupChange={setSelectedGroupId}
      >
        {modelTree}
        {mainSection}
        {contextPanel}
      </GroupsDndProvider>
    ) : (
      <>
        {modelTree}
        {mainSection}
        {contextPanel}
      </>
    )

  return (
    <>
      <ArchitectureCommandPalette
        open={commandOpen}
        activeModelName={activeModelName}
        models={projectModels}
        templates={templates}
        disabled={editingLocked}
        onOpenChange={setCommandOpen}
        onCreateBlank={createBlankProjectModel}
        onOpenModel={openProjectModel}
        onSaveAs={saveCurrentModelAs}
        onDeleteModel={deleteProjectModelByName}
        onLoadTemplate={createModelFromTemplate}
      />
      <div
        className="absolute inset-0 flex min-h-0 min-w-0 bg-background text-foreground"
        data-testid="architecture-panel"
        style={architectureThemeStyle}
      >
        {panelContent}
        {drift && (drift.nodes.length > 0 || drift.structureChanged) ? (
          <div
            className="absolute bottom-3 right-[25rem] z-20 rounded border border-border bg-background p-3 text-xs shadow"
            data-testid="architecture-drift-report"
          >
            <div className="font-medium">Drift report</div>
            <div className="mt-1 text-muted-foreground">
              Structure changed: {drift.structureChanged ? 'yes' : 'no'}
            </div>
            {drift.nodes.map((node) => (
              <div key={node.nodeId} className="mt-2">
                <div>{node.nodeName}</div>
                <div className="text-muted-foreground">{node.patterns.join(', ')}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  )
}
