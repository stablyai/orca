/* eslint-disable max-lines -- Why: this hook centralizes Scryer's model storage, selection, history, drift, and sync controller logic before it is split into narrower hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { detectLanguage } from '../../lib/language-detect'
import { launchAgentInNewTab } from '../../lib/launch-agent-in-new-tab'
import { useAppStore } from '../../store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { ArchitectureWorkspace } from '../../../../shared/types'
import type {
  ArchitectureDriftReport,
  ArchitectureGroup,
  ArchitectureDiagramKind,
  ArchitectureDiagramModel,
  ArchitectureDiagramNode,
  ArchitectureDiagramNodeData,
  ArchitectureSourceLocation
} from './architecture-diagram-types'
import type { ScryerCompletionGateResult } from '../../../../shared/scryer/edit-session'
import { resolveSourceLocationTarget } from '../../../../shared/scryer/source-map-paths'
import type { ModelUpdater } from './ArchitectureCanvas'
import type { SyncStatus } from './SyncBar'
import {
  analyzeExternalModelUpdate,
  isExpandableKind,
  nextKindForParent,
  reconcileExpandedPath
} from './architecture-diagram-model'
import {
  sanitizeClientModelName,
  useArchitectureModelSession,
  type ArchitectureProjectModelEntry
} from './useArchitectureModelSession'
import { useArchitectureAiRunSession } from './useArchitectureAiRunSession'

export type {
  ArchitectureProjectModelEntry,
  ArchitectureTemplateEntry
} from './useArchitectureModelSession'

export type ArchitectureMode = 'topology' | 'groups'

type SyncSessionStatus = SyncStatus
type ArchitectureOperationEnvelope =
  | { ok: true; requestId: string; result?: unknown; meta?: unknown }
  | { ok: false; error: { message: string }; requestId?: string; meta?: unknown }
const EMPTY_PTY_IDS: string[] = []
export const ARCHITECTURE_HISTORY_LIMIT = 10
export const ARCHITECTURE_HISTORY_BATCH_MS = 1_000

function firstAddedId(envelope: ArchitectureOperationEnvelope | null): string | null {
  if (!envelope?.ok || !envelope.result || typeof envelope.result !== 'object') {
    return null
  }
  const added = (envelope.result as { added?: unknown }).added
  if (!Array.isArray(added)) {
    return null
  }
  const first = added[0]
  if (!first || typeof first !== 'object') {
    return null
  }
  const id = (first as { id?: unknown }).id
  return typeof id === 'string' ? id : null
}

function isCodeLevelKind(kind: ArchitectureDiagramKind): boolean {
  return kind === 'operation' || kind === 'process' || kind === 'model'
}

type ActiveArchitectureSyncTerminal = {
  projectPath: string
  tabId: string
  ptyIds: Set<string>
  startedAt: number
  finishing: boolean
  finish: () => void
}

export function pushArchitectureUndoSnapshot(
  stack: ArchitectureDiagramModel[],
  snapshot: ArchitectureDiagramModel,
  args: { batchStartedAt: number | null; now: number }
): { stack: ArchitectureDiagramModel[]; batchStartedAt: number; captured: boolean } {
  if (
    args.batchStartedAt !== null &&
    args.now - args.batchStartedAt < ARCHITECTURE_HISTORY_BATCH_MS
  ) {
    return { stack, batchStartedAt: args.batchStartedAt, captured: false }
  }

  return {
    stack: [...stack, snapshot].slice(-ARCHITECTURE_HISTORY_LIMIT),
    batchStartedAt: args.now,
    captured: true
  }
}

const activeArchitectureSyncTerminals = new Map<string, ActiveArchitectureSyncTerminal>()
let syncTerminalStoreUnsubscribe: (() => void) | null = null
let syncTerminalExitUnsubscribe: (() => void) | null = null

function cleanupArchitectureSyncTerminalWatchers(): void {
  if (activeArchitectureSyncTerminals.size > 0) {
    return
  }
  syncTerminalStoreUnsubscribe?.()
  syncTerminalStoreUnsubscribe = null
  syncTerminalExitUnsubscribe?.()
  syncTerminalExitUnsubscribe = null
}

export function findCompletedArchitectureSyncPane(args: {
  tabId: string
  startedAt: number
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
}): { paneKey: string; interrupted: boolean } | null {
  const panePrefix = `${args.tabId}:`
  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    if (!paneKey.startsWith(panePrefix)) {
      continue
    }
    if (entry.updatedAt < args.startedAt) {
      continue
    }
    if (entry.state === 'done') {
      return { paneKey, interrupted: entry.interrupted === true }
    }
  }
  return null
}

function finishTrackedArchitectureSync(
  tabId: string,
  session: ActiveArchitectureSyncTerminal
): void {
  if (session.finishing) {
    return
  }
  session.finishing = true
  void Promise.resolve(session.finish())
    .catch((error: unknown) => {
      console.error('[architecture] auto finish sync failed', error)
    })
    .finally(() => {
      activeArchitectureSyncTerminals.delete(tabId)
      cleanupArchitectureSyncTerminalWatchers()
    })
}

function ensureArchitectureSyncTerminalWatchers(): void {
  if (!syncTerminalStoreUnsubscribe) {
    syncTerminalStoreUnsubscribe = useAppStore.subscribe((state) => {
      for (const [tabId, session] of activeArchitectureSyncTerminals) {
        for (const ptyId of state.ptyIdsByTabId[session.tabId] ?? []) {
          session.ptyIds.add(ptyId)
        }
        const completed = findCompletedArchitectureSyncPane({
          tabId: session.tabId,
          startedAt: session.startedAt,
          agentStatusByPaneKey: state.agentStatusByPaneKey
        })
        if (!completed) {
          continue
        }
        if (completed.interrupted) {
          activeArchitectureSyncTerminals.delete(tabId)
          cleanupArchitectureSyncTerminalWatchers()
          continue
        }
        finishTrackedArchitectureSync(tabId, session)
      }
    })
  }

  if (!syncTerminalExitUnsubscribe) {
    syncTerminalExitUnsubscribe = window.api.pty.onExit(({ id, code }) => {
      for (const [tabId, session] of activeArchitectureSyncTerminals) {
        if (!session.ptyIds.has(id)) {
          continue
        }
        session.ptyIds.delete(id)
        if (code === 0) {
          finishTrackedArchitectureSync(tabId, session)
          return
        }
        activeArchitectureSyncTerminals.delete(tabId)
        cleanupArchitectureSyncTerminalWatchers()
      }
    })
  }
}

function trackArchitectureSyncTerminal(
  projectPath: string,
  tabId: string,
  finish: () => void
): void {
  const state = useAppStore.getState()
  const session: ActiveArchitectureSyncTerminal = {
    projectPath,
    tabId,
    ptyIds: new Set(state.ptyIdsByTabId[tabId] ?? []),
    startedAt: Date.now(),
    finishing: false,
    finish
  }
  activeArchitectureSyncTerminals.set(tabId, session)
  ensureArchitectureSyncTerminalWatchers()
}

function readInitialFollowExternalChanges(): boolean {
  try {
    return window.localStorage.getItem('orca-scryer:follow-external-changes') !== 'false'
  } catch {
    return true
  }
}

function buildAncestorPath(model: ArchitectureDiagramModel, nodeId: string): string[] {
  const path: string[] = []
  let current = model.nodes.find((node) => node.id === nodeId)?.parentId ?? undefined
  while (current) {
    path.unshift(current)
    current = model.nodes.find((node) => node.id === current)?.parentId
  }
  return path
}

export function createEmptyArchitectureModel(projectPath: string): ArchitectureDiagramModel {
  return {
    nodes: [],
    links: [],
    startingLevel: 'system',
    sourceMap: {},
    boundaries: {},
    projectPath,
    refPositions: {},
    groups: []
  }
}

function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableFingerprintValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const nextValue = (value as Record<string, unknown>)[key]
    if (nextValue !== undefined && typeof nextValue !== 'function') {
      result[key] = stableFingerprintValue(nextValue)
    }
  }
  return result
}

export function fingerprintArchitectureModel(model: ArchitectureDiagramModel): string {
  return JSON.stringify(stableFingerprintValue(model))
}

function fingerprintNodeData(data: ArchitectureDiagramNodeData): string {
  return JSON.stringify(stableFingerprintValue(data))
}

function nodeDiffDismissalKey(modelName: string, nodeId: string): string {
  return `${sanitizeClientModelName(modelName)}:${nodeId}`
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function boundarySourcesFromLocations(
  locations: ArchitectureSourceLocation[]
): { pattern: string; comment?: string }[] {
  return locations
    .map((location) => ({
      pattern: location.pattern.trim(),
      comment: location.command?.trim() || undefined
    }))
    .filter((source) => source.pattern)
}

function sourceMapLocationsFromRows(
  locations: ArchitectureSourceLocation[]
): ArchitectureSourceLocation[] {
  return locations
    .map((location) => ({
      pattern: location.pattern.trim(),
      ...(location.symbol?.trim() ? { symbol: location.symbol.trim() } : {}),
      ...(location.line !== undefined ? { line: location.line } : {}),
      ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
      ...(location.command?.trim() ? { command: location.command.trim() } : {})
    }))
    .filter((location) => location.pattern)
}

export function sourcePatternForNode(
  model: ArchitectureDiagramModel,
  nodeId: string | null
): string {
  if (!nodeId) {
    return ''
  }
  return model.boundaries?.[nodeId]?.[0]?.pattern ?? model.sourceMap?.[nodeId]?.[0]?.pattern ?? ''
}

export function modelWithVisibleSourcePattern(
  model: ArchitectureDiagramModel,
  nodeId: string | null,
  rawPattern: string
): ArchitectureDiagramModel {
  if (!nodeId) {
    return model
  }
  const pattern = rawPattern.trim()
  const boundaries = { ...model.boundaries }
  if (pattern) {
    boundaries[nodeId] = [{ pattern }]
  } else {
    delete boundaries[nodeId]
  }
  return { ...model, boundaries }
}

export function modelWithNodeDrafts(
  model: ArchitectureDiagramModel,
  drafts: Map<string, Partial<ArchitectureDiagramNode['data']>>
): ArchitectureDiagramModel {
  if (drafts.size === 0) {
    return model
  }
  return {
    ...model,
    nodes: model.nodes.map((node) => {
      const draft = drafts.get(node.id)
      return draft ? { ...node, data: { ...node.data, ...draft } } : node
    })
  }
}

function scryerKindForDiagramKind(kind: ArchitectureDiagramKind): string {
  return kind === 'operation' || kind === 'process' || kind === 'model' ? 'symbol' : kind
}

export function nodeUpdateInputFromDiagramPatch(
  nodeId: string,
  patch: Partial<ArchitectureDiagramNodeData>
): { nodes: Record<string, unknown>[] } | null {
  const node: Record<string, unknown> = { node_id: nodeId }
  if (typeof patch.name === 'string') {
    node.name = patch.name
  }
  if (typeof patch.description === 'string') {
    node.description = patch.description
  }
  if (typeof patch.technology === 'string') {
    node.technology = patch.technology
  }
  if (typeof patch.external === 'boolean') {
    node.external = patch.external
  }
  if (Array.isArray(patch.properties)) {
    node.properties = patch.properties
  }
  if (typeof patch.kind === 'string') {
    node.kind = scryerKindForDiagramKind(patch.kind)
  }
  if ('shape' in patch) {
    node.appearance = { shape: patch.shape ?? null }
  }
  return Object.keys(node).length > 1 ? { nodes: [node] } : null
}

function nodeUpdatesForHistorySnapshot(model: ArchitectureDiagramModel): Record<string, unknown>[] {
  return model.nodes.map((node) => ({
    node_id: node.id,
    kind: scryerKindForDiagramKind(node.data.kind),
    name: node.data.name,
    description: node.data.description,
    ...(node.data.technology !== undefined ? { technology: node.data.technology } : {}),
    ...(node.data.external !== undefined ? { external: node.data.external } : {}),
    ...(node.data.properties !== undefined ? { properties: node.data.properties } : {}),
    ...(node.data.visual !== undefined ? { visual: node.data.visual } : {}),
    ...(node.data.shape !== undefined ? { appearance: { shape: node.data.shape } } : {}),
    ...(node.parentId !== undefined ? { parent_id: node.parentId } : {})
  }))
}

function boundaryUpdatesForHistorySnapshot(
  model: ArchitectureDiagramModel
): Record<string, unknown>[] {
  return model.nodes.map((node) => ({
    node_id: node.id,
    sources: model.boundaries?.[node.id] ?? []
  }))
}

function isArchitecturePanelEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const tagName = target.tagName.toLowerCase()
  return (
    !!target.closest('[data-testid="architecture-panel"]') &&
    (tagName === 'input' || tagName === 'textarea' || target.isContentEditable)
  )
}

export function useArchitectureModelController({
  workspace
}: {
  workspace: ArchitectureWorkspace
}) {
  const projectPath = workspace.projectPath ?? ''
  const openFile = useAppStore((state) => state.openFile)
  const setPendingEditorReveal = useAppStore((state) => state.setPendingEditorReveal)
  const setArchitectureModelRef = useAppStore((state) => state.setArchitectureModelRef)
  const settingsDefaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const detectedAgentIds = useAppStore((state) => state.detectedAgentIds)
  const [model, setModel] = useState<ArchitectureDiagramModel | null>(null)
  const modelRef = useRef<ArchitectureDiagramModel | null>(null)
  const visibleModelRef = useRef<ArchitectureDiagramModel | null>(null)
  const nodeDraftsRef = useRef<Map<string, Partial<ArchitectureDiagramNode['data']>>>(new Map())
  const loadRequestIdRef = useRef(0)
  const viewMutationEpochRef = useRef(0)
  const architectureWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const lastKnownModelFingerprintRef = useRef('')
  const undoStackRef = useRef<ArchitectureDiagramModel[]>([])
  const redoStackRef = useRef<ArchitectureDiagramModel[]>([])
  const historyBatchStartedAtRef = useRef<number | null>(null)
  const expandedPathRef = useRef<string[]>([])
  const lastCodeLevelParentIdRef = useRef<string | null>(null)
  const followExternalChangesRef = useRef(true)
  const selectedNodeIdRef = useRef<string | null>(null)
  const sourcePatternSyncRef = useRef<{ nodeId: string | null; pattern: string } | null>(null)
  const visibleSourcePatternRef = useRef('')
  const selectedEdgeIdRef = useRef<string | null>(null)
  const syncTerminalTabIdRef = useRef<string | null>(null)
  const syncTerminalHadPtyRef = useRef(false)
  const syncTerminalPtyIdsRef = useRef<Set<string>>(new Set())
  const autoFinishingSyncRef = useRef(false)
  const syncResolutionRef = useRef<'cancel' | 'finish' | null>(null)
  const finishSyncRef = useRef<() => Promise<void>>(async () => undefined)
  const activeModelReloadRef = useRef<() => void>(() => {})
  const activeModelRemovedRef = useRef<
    (removedModelName: string, knownModels: ArchitectureProjectModelEntry[]) => void
  >(() => {})
  const [architectureMode, setArchitectureMode] = useState<ArchitectureMode>('topology')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [multiSelectedNodeIds, setMultiSelectedNodeIds] = useState<string[]>([])
  const [totalSelected, setTotalSelected] = useState(0)
  const [expandedPath, setExpandedPath] = useState<string[]>([])
  const [followExternalChanges, setFollowExternalChanges] = useState(
    readInitialFollowExternalChanges
  )
  const [changedNodeIds, setChangedNodeIds] = useState<Set<string>>(new Set())
  const [nodeDiffs, setNodeDiffs] = useState<Map<string, ArchitectureDiagramNodeData>>(new Map())
  const dismissedNodeDiffKeysRef = useRef<Map<string, string>>(new Map())
  const [targetNodeId, setTargetNodeId] = useState<string>('')
  const [sourcePattern, setSourcePatternState] = useState('')
  const [drift, setDrift] = useState<ArchitectureDriftReport | null>(null)
  const [implementing, setImplementing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncSessionStatus>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [syncLog, setSyncLog] = useState<string[]>([])
  const [syncTerminalTabId, setSyncTerminalTabId] = useState<string | null>(null)
  const [completionGate, setCompletionGate] = useState<ScryerCompletionGateResult | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [message, setMessage] = useState<string>('')
  const [error, setError] = useState<string>('')
  const aiRunSession = useArchitectureAiRunSession()

  const setSourcePattern = useCallback((pattern: string) => {
    visibleSourcePatternRef.current = pattern
    setSourcePatternState(pattern)
  }, [])

  const enqueueArchitectureWrite = useCallback(<T>(operation: () => Promise<T>): Promise<T> => {
    const run = architectureWriteQueueRef.current.catch(() => undefined).then(operation)
    architectureWriteQueueRef.current = run.catch(() => undefined)
    return run
  }, [])

  const handleModelSessionError = useCallback((sessionError: unknown) => {
    setError(sessionError instanceof Error ? sessionError.message : String(sessionError))
  }, [])

  const modelSession = useArchitectureModelSession({
    workspace,
    projectPath,
    setArchitectureModelRef,
    isActiveModelEditableTarget: () => isArchitecturePanelEditableTarget(document.activeElement),
    onActiveModelReload: () => activeModelReloadRef.current(),
    onActiveModelRemoved: (removedModelName, knownModels) =>
      activeModelRemovedRef.current(removedModelName, knownModels),
    onError: handleModelSessionError
  })
  const {
    activeModelName,
    activeModelNameRef,
    projectModels,
    templates,
    readArchitectureViewDocument,
    acceptLoadedArchitectureViewDocument,
    refreshProjectModels,
    flushPendingArchitectureViewWork
  } = modelSession

  const currentParentId = expandedPath.at(-1)
  const currentParent = useMemo(
    () => model?.nodes.find((node) => node.id === currentParentId) ?? null,
    [currentParentId, model]
  )
  const currentParentKind = currentParent?.data.kind
  const canShowGroups = currentParentKind === 'system' || currentParentKind === 'container'
  const canGroupMultiSelection =
    architectureMode === 'topology' &&
    !!currentParentId &&
    currentParentKind !== 'component' &&
    multiSelectedNodeIds.length >= 2

  const selectedNodeById = useMemo(
    () => model?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [model, selectedNodeId]
  )
  const selectedEdge = useMemo(
    () => model?.links.find((edge) => edge.id === selectedEdgeId) ?? null,
    [model, selectedEdgeId]
  )
  const selectedGroup = useMemo(
    () => model?.groups?.find((group) => group.id === selectedGroupId) ?? null,
    [model, selectedGroupId]
  )

  const driftedNodeIds = useMemo(
    () => new Set((drift?.nodes ?? []).map((node) => node.nodeId)),
    [drift]
  )

  const codeLevelNodes = useMemo(
    () =>
      model && currentParentKind === 'component' && currentParentId
        ? model.nodes.filter(
            (node) =>
              node.parentId === currentParentId &&
              (node.data.kind === 'operation' ||
                node.data.kind === 'process' ||
                node.data.kind === 'model')
          )
        : [],
    [currentParentId, currentParentKind, model]
  )
  const selectedNode = useMemo(() => {
    if (selectedNodeById) {
      return selectedNodeById
    }
    if (currentParentKind !== 'component') {
      return null
    }
    return (
      codeLevelNodes.find((node) => node.id === selectedNodeIdRef.current) ??
      codeLevelNodes[0] ??
      null
    )
  }, [codeLevelNodes, currentParentKind, selectedNodeById])
  const selectedSourcePattern = selectedNode
    ? (model?.boundaries?.[selectedNode.id]?.[0]?.pattern ??
      model?.sourceMap?.[selectedNode.id]?.[0]?.pattern ??
      '')
    : ''

  const activeAgent = useMemo(() => {
    if (!projectPath) {
      return null
    }
    const name =
      settingsDefaultAgent && settingsDefaultAgent !== 'blank'
        ? settingsDefaultAgent
        : (detectedAgentIds?.[0] ?? 'codex')
    return { name, available: true }
  }, [detectedAgentIds, projectPath, settingsDefaultAgent])

  const editingLocked = syncStatus === 'running' || implementing
  const syncTerminalPtyIds = useAppStore((state) =>
    syncTerminalTabId ? (state.ptyIdsByTabId[syncTerminalTabId] ?? EMPTY_PTY_IDS) : EMPTY_PTY_IDS
  )
  const syncTerminalPtyIdsKey = syncTerminalPtyIds.join('\0')
  const syncTerminalPtyCount = syncTerminalPtyIds.length
  const canUndo = historyRevision >= 0 && undoStackRef.current.length > 0
  const canRedo = historyRevision >= 0 && redoStackRef.current.length > 0

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId
  }, [selectedNodeId])

  useEffect(() => {
    selectedEdgeIdRef.current = selectedEdgeId
  }, [selectedEdgeId])

  useEffect(() => {
    syncTerminalTabIdRef.current = syncTerminalTabId
  }, [syncTerminalTabId])

  useEffect(() => {
    expandedPathRef.current = expandedPath
  }, [expandedPath])

  useEffect(() => {
    if (currentParentKind === 'component' && currentParentId) {
      lastCodeLevelParentIdRef.current = currentParentId
    }
  }, [currentParentId, currentParentKind])

  useEffect(() => {
    followExternalChangesRef.current = followExternalChanges
    try {
      window.localStorage.setItem(
        'orca-scryer:follow-external-changes',
        String(followExternalChanges)
      )
    } catch {
      // Storage can be unavailable in constrained test windows; the current state still works.
    }
  }, [followExternalChanges])

  useEffect(() => {
    if (architectureMode !== 'topology') {
      setSelectedNodeId(null)
      setSelectedEdgeId(null)
      setMultiSelectedNodeIds([])
      setTotalSelected(0)
    }
    if (architectureMode !== 'groups') {
      setSelectedGroupId(null)
    }
  }, [architectureMode])

  const loadModel = useCallback(
    async (requestedModelName?: string | null) => {
      const requestId = loadRequestIdRef.current + 1
      loadRequestIdRef.current = requestId
      if (!projectPath) {
        const emptyModel = createEmptyArchitectureModel('')
        if (requestId !== loadRequestIdRef.current) {
          return
        }
        modelRef.current = emptyModel
        visibleModelRef.current = emptyModel
        setModel(emptyModel)
        setError('Architecture tabs need a worktree path.')
        return
      }
      const nextActiveModelName = sanitizeClientModelName(
        requestedModelName ?? activeModelNameRef.current
      )
      try {
        setError('')
        const loadedDocument = await readArchitectureViewDocument(nextActiveModelName)
        if (requestId !== loadRequestIdRef.current) {
          return
        }
        const loaded = loadedDocument.model
        const loadedFingerprint = fingerprintArchitectureModel(loaded)
        const previous = modelRef.current
        const currentSelectedNodeId = selectedNodeIdRef.current
        const currentSelectedEdgeId = selectedEdgeIdRef.current
        const nodeStillSelected =
          !!currentSelectedNodeId && loaded.nodes.some((node) => node.id === currentSelectedNodeId)
        const edgeStillSelected =
          !!currentSelectedEdgeId && loaded.links.some((edge) => edge.id === currentSelectedEdgeId)

        let nextModel = loaded
        let nextExpandedPath: string[] | null = null
        let nextExternalNodeId: string | null = null
        if (
          previous &&
          lastKnownModelFingerprintRef.current &&
          loadedFingerprint !== lastKnownModelFingerprintRef.current
        ) {
          const summary = analyzeExternalModelUpdate({
            previous,
            incoming: loaded,
            expandedPath: expandedPathRef.current,
            followExternalChanges: followExternalChangesRef.current
          })
          nextModel = summary.model
          nextExpandedPath = summary.expandedPath
          if (followExternalChangesRef.current) {
            nextExternalNodeId =
              summary.nodeDiffs.keys().next().value ??
              [...summary.changedNodeIds].find((nodeId) =>
                nextModel.nodes.some((node) => node.id === nodeId)
              ) ??
              null
          }
          if (summary.changedNodeIds.size > 0) {
            setChangedNodeIds((current) => new Set([...current, ...summary.changedNodeIds]))
          }
          if (summary.nodeDiffs.size > 0) {
            setNodeDiffs((current) => {
              const merged = new Map(current)
              for (const [nodeId, oldData] of summary.nodeDiffs) {
                const currentNode = nextModel.nodes.find((node) => node.id === nodeId)
                if (
                  currentNode &&
                  dismissedNodeDiffKeysRef.current.get(
                    nodeDiffDismissalKey(nextActiveModelName, nodeId)
                  ) === fingerprintNodeData(currentNode.data)
                ) {
                  continue
                }
                if (!merged.has(nodeId)) {
                  merged.set(nodeId, oldData)
                }
              }
              return merged
            })
          }
        }

        const [nextImplementing, hasPreSyncSnapshot] = await Promise.all([
          window.api.architecture.isSyncing({ projectPath }),
          window.api.architecture.hasPreSyncSnapshot({ projectPath })
        ])
        if (requestId !== loadRequestIdRef.current) {
          return
        }

        lastKnownModelFingerprintRef.current = loadedFingerprint
        acceptLoadedArchitectureViewDocument(nextActiveModelName, loadedDocument.revision)
        const visibleNextModel = modelWithNodeDrafts(nextModel, nodeDraftsRef.current)
        modelRef.current = nextModel
        visibleModelRef.current = visibleNextModel
        setModel(visibleNextModel)
        setExpandedPath(
          (current) => nextExpandedPath ?? reconcileExpandedPath(visibleNextModel, current)
        )
        const nextSelectedNodeId =
          nextExternalNodeId ??
          (nodeStillSelected
            ? currentSelectedNodeId
            : edgeStillSelected
              ? null
              : (nextModel.nodes[0]?.id ?? null))
        const nextSelectedEdgeId = nextSelectedNodeId
          ? null
          : edgeStillSelected
            ? currentSelectedEdgeId
            : null
        selectedNodeIdRef.current = nextSelectedNodeId
        selectedEdgeIdRef.current = nextSelectedEdgeId
        setSelectedNodeId(nextSelectedNodeId)
        setSelectedEdgeId(nextSelectedEdgeId)
        setSelectedGroupId((current) =>
          current && (nextModel.groups ?? []).some((group) => group.id === current) ? current : null
        )
        setImplementing(nextImplementing)
        setSyncStatus((current) => {
          if (nextImplementing && hasPreSyncSnapshot) {
            return 'running'
          }
          return current === 'running' ? 'idle' : current
        })
        if (nextImplementing && hasPreSyncSnapshot) {
          setSyncLog((current) =>
            current.length > 0 ? current : ['Architecture sync is still in progress']
          )
        }
        void refreshProjectModels()
        setMessage(`Model loaded: ${nextActiveModelName}`)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    },
    [
      acceptLoadedArchitectureViewDocument,
      activeModelNameRef,
      projectPath,
      readArchitectureViewDocument,
      refreshProjectModels
    ]
  )

  const loadFallbackModelAfterRemoval = useCallback(
    async (removedModelName: string, knownModels?: ArchitectureProjectModelEntry[]) => {
      if (!projectPath) {
        return
      }
      const remaining = knownModels ?? (await window.api.architecture.listModels({ projectPath }))
      const nextName =
        remaining.find((entry) => entry.name !== removedModelName)?.name ??
        remaining[0]?.name ??
        'model'
      if (remaining.length === 0) {
        await window.api.architecture.createModel({ projectPath, modelName: nextName })
      }
      await loadModel(nextName)
      void refreshProjectModels()
    },
    [loadModel, projectPath, refreshProjectModels]
  )

  const executeArchitectureWrite = useCallback(
    async (operationId: string, input: unknown, nextMessage: string) => {
      if (!projectPath) {
        return null
      }
      const epoch = viewMutationEpochRef.current
      const result = await enqueueArchitectureWrite(async () => {
        if (viewMutationEpochRef.current !== epoch) {
          return null
        }
        const envelope = (await window.api.architecture.executeScryerOperation({
          projectPath,
          operationId,
          input
        })) as ArchitectureOperationEnvelope
        if (!envelope.ok) {
          throw new Error(envelope.error.message)
        }
        if (viewMutationEpochRef.current === epoch) {
          await loadModel('model')
        }
        return envelope
      })
      setMessage(nextMessage)
      return result
    },
    [enqueueArchitectureWrite, loadModel, projectPath]
  )

  const persist = useCallback(
    async (
      nextModel: ArchitectureDiagramModel,
      nextMessage: string,
      options: { captureHistory?: boolean } = {}
    ) => {
      if (!projectPath) {
        return
      }
      const current = modelRef.current
      if (
        options.captureHistory !== false &&
        current &&
        fingerprintArchitectureModel(current) !== fingerprintArchitectureModel(nextModel)
      ) {
        const history = pushArchitectureUndoSnapshot(undoStackRef.current, current, {
          batchStartedAt: historyBatchStartedAtRef.current,
          now: Date.now()
        })
        undoStackRef.current = history.stack
        historyBatchStartedAtRef.current = history.batchStartedAt
        redoStackRef.current = []
        setHistoryRevision((revision) => revision + 1)
      }
      const nextFingerprint = fingerprintArchitectureModel(nextModel)
      modelRef.current = nextModel
      visibleModelRef.current = nextModel
      setModel(nextModel)
      lastKnownModelFingerprintRef.current = nextFingerprint
      setMessage(nextMessage)
    },
    [projectPath]
  )

  const applyModelChange = useCallback(
    async (change: ArchitectureDiagramModel | ModelUpdater, nextMessage: string) => {
      const current = modelRef.current
      if (!current) {
        return
      }
      const nextModel = typeof change === 'function' ? change(current) : change
      if (!nextModel) {
        return
      }
      await persist(nextModel, nextMessage)
    },
    [persist]
  )

  const persistHistorySnapshot = useCallback(
    async (snapshot: ArchitectureDiagramModel, nextMessage: string) => {
      const nodes = nodeUpdatesForHistorySnapshot(snapshot)
      if (nodes.length > 0) {
        await executeArchitectureWrite('scryer.node.update', { nodes }, nextMessage)
      }
      const boundaries = boundaryUpdatesForHistorySnapshot(snapshot)
      if (boundaries.length > 0) {
        await executeArchitectureWrite('scryer.source.update', { boundaries }, nextMessage)
      }
    },
    [executeArchitectureWrite]
  )

  const undoModelChange = useCallback(async () => {
    if (editingLocked) {
      return
    }
    const visibleCurrent = model ?? visibleModelRef.current ?? modelRef.current
    const currentWithDrafts = visibleCurrent
      ? modelWithNodeDrafts(visibleCurrent, nodeDraftsRef.current)
      : null
    const current = currentWithDrafts
      ? modelWithVisibleSourcePattern(
          currentWithDrafts,
          selectedNodeIdRef.current,
          visibleSourcePatternRef.current
        )
      : null
    const snapshot = undoStackRef.current.at(-1)
    if (!current || !snapshot) {
      return
    }
    viewMutationEpochRef.current += 1
    nodeDraftsRef.current.clear()
    undoStackRef.current = undoStackRef.current.slice(0, -1)
    redoStackRef.current = [...redoStackRef.current, current].slice(-ARCHITECTURE_HISTORY_LIMIT)
    historyBatchStartedAtRef.current = null
    setHistoryRevision((revision) => revision + 1)
    const currentSelectedNodeId = selectedNodeIdRef.current
    const currentSelectedEdgeId = selectedEdgeIdRef.current
    const nextSelectedNodeId =
      currentSelectedNodeId && snapshot.nodes.some((node) => node.id === currentSelectedNodeId)
        ? currentSelectedNodeId
        : (snapshot.nodes[0]?.id ?? null)
    const nextSelectedEdgeId =
      !nextSelectedNodeId &&
      currentSelectedEdgeId &&
      snapshot.links.some((edge) => edge.id === currentSelectedEdgeId)
        ? currentSelectedEdgeId
        : null
    selectedNodeIdRef.current = nextSelectedNodeId
    selectedEdgeIdRef.current = nextSelectedEdgeId
    setSelectedNodeId(nextSelectedNodeId)
    setSelectedEdgeId(nextSelectedEdgeId)
    const nextSourcePattern = sourcePatternForNode(snapshot, nextSelectedNodeId)
    setSourcePattern(nextSourcePattern)
    sourcePatternSyncRef.current = { nodeId: nextSelectedNodeId, pattern: nextSourcePattern }
    await persist(snapshot, 'Undid architecture change', { captureHistory: false })
    await persistHistorySnapshot(snapshot, 'Undid architecture change')
    setExpandedPath((path) => reconcileExpandedPath(snapshot, path))
  }, [editingLocked, model, persist, persistHistorySnapshot])

  const redoModelChange = useCallback(async () => {
    if (editingLocked) {
      return
    }
    const visibleCurrent = model ?? visibleModelRef.current ?? modelRef.current
    const currentWithDrafts = visibleCurrent
      ? modelWithNodeDrafts(visibleCurrent, nodeDraftsRef.current)
      : null
    const current = currentWithDrafts
      ? modelWithVisibleSourcePattern(
          currentWithDrafts,
          selectedNodeIdRef.current,
          visibleSourcePatternRef.current
        )
      : null
    const snapshot = redoStackRef.current.at(-1)
    if (!current || !snapshot) {
      return
    }
    viewMutationEpochRef.current += 1
    nodeDraftsRef.current.clear()
    redoStackRef.current = redoStackRef.current.slice(0, -1)
    undoStackRef.current = [...undoStackRef.current, current].slice(-ARCHITECTURE_HISTORY_LIMIT)
    historyBatchStartedAtRef.current = null
    setHistoryRevision((revision) => revision + 1)
    const currentSelectedNodeId = selectedNodeIdRef.current
    const currentSelectedEdgeId = selectedEdgeIdRef.current
    const nextSelectedNodeId =
      currentSelectedNodeId && snapshot.nodes.some((node) => node.id === currentSelectedNodeId)
        ? currentSelectedNodeId
        : (snapshot.nodes[0]?.id ?? null)
    const nextSelectedEdgeId =
      !nextSelectedNodeId &&
      currentSelectedEdgeId &&
      snapshot.links.some((edge) => edge.id === currentSelectedEdgeId)
        ? currentSelectedEdgeId
        : null
    selectedNodeIdRef.current = nextSelectedNodeId
    selectedEdgeIdRef.current = nextSelectedEdgeId
    setSelectedNodeId(nextSelectedNodeId)
    setSelectedEdgeId(nextSelectedEdgeId)
    const nextSourcePattern = sourcePatternForNode(snapshot, nextSelectedNodeId)
    setSourcePattern(nextSourcePattern)
    sourcePatternSyncRef.current = { nodeId: nextSelectedNodeId, pattern: nextSourcePattern }
    await persist(snapshot, 'Redid architecture change', { captureHistory: false })
    await persistHistorySnapshot(snapshot, 'Redid architecture change')
    setExpandedPath((path) => reconcileExpandedPath(snapshot, path))
  }, [editingLocked, model, persist, persistHistorySnapshot])

  useEffect(() => {
    void loadModel()
  }, [loadModel])

  useEffect(() => {
    activeModelReloadRef.current = () => void loadModel()
    activeModelRemovedRef.current = (removedModelName, knownModels) => {
      void loadFallbackModelAfterRemoval(removedModelName, knownModels)
    }
  }, [loadFallbackModelAfterRemoval, loadModel])

  const createBlankProjectModel = useCallback(
    async (modelName: string) => {
      if (!projectPath || editingLocked) {
        return
      }
      const result = await window.api.architecture.createModel({
        projectPath,
        modelName
      })
      undoStackRef.current = []
      redoStackRef.current = []
      historyBatchStartedAtRef.current = null
      setHistoryRevision((revision) => revision + 1)
      await loadModel(result.modelName)
    },
    [editingLocked, loadModel, projectPath]
  )

  const createModelFromTemplate = useCallback(
    async (templateId: string, modelName: string) => {
      if (!projectPath || editingLocked) {
        return
      }
      const result = await window.api.architecture.createModel({
        projectPath,
        modelName,
        templateId
      })
      undoStackRef.current = []
      redoStackRef.current = []
      historyBatchStartedAtRef.current = null
      setHistoryRevision((revision) => revision + 1)
      await loadModel(result.modelName)
    },
    [editingLocked, loadModel, projectPath]
  )

  const openProjectModel = useCallback(
    async (modelName: string, scope: ArchitectureProjectModelEntry['scope'] = 'project') => {
      if (editingLocked) {
        return
      }
      undoStackRef.current = []
      redoStackRef.current = []
      historyBatchStartedAtRef.current = null
      setHistoryRevision((revision) => revision + 1)
      await flushPendingArchitectureViewWork()
      if (projectPath && scope === 'global') {
        const result = await window.api.architecture.migrateGlobalModel({ projectPath, modelName })
        await loadModel(result.modelName)
        return
      }
      await loadModel(modelName)
    },
    [editingLocked, flushPendingArchitectureViewWork, loadModel, projectPath]
  )

  const saveCurrentModelAs = useCallback(
    async (modelName: string) => {
      if (!projectPath || editingLocked) {
        return
      }
      await flushPendingArchitectureViewWork()
      const result = await window.api.architecture.saveModelAs({
        projectPath,
        fromModelName: activeModelNameRef.current,
        toModelName: modelName
      })
      undoStackRef.current = []
      redoStackRef.current = []
      historyBatchStartedAtRef.current = null
      setHistoryRevision((revision) => revision + 1)
      await loadModel(result.modelName)
    },
    [activeModelNameRef, editingLocked, flushPendingArchitectureViewWork, loadModel, projectPath]
  )

  const deleteProjectModelByName = useCallback(
    async (modelName: string) => {
      if (!projectPath || editingLocked) {
        return
      }
      await flushPendingArchitectureViewWork()
      const removedModelName = sanitizeClientModelName(modelName)
      await window.api.architecture.deleteModel({ projectPath, modelName })
      await loadFallbackModelAfterRemoval(removedModelName)
    },
    [editingLocked, flushPendingArchitectureViewWork, loadFallbackModelAfterRemoval, projectPath]
  )

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) {
        return
      }
      if (!(event.metaKey || event.ctrlKey)) {
        return
      }
      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault()
        void undoModelChange()
      } else if (
        event.key.toLowerCase() === 'y' ||
        (event.key.toLowerCase() === 'z' && event.shiftKey)
      ) {
        event.preventDefault()
        void redoModelChange()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [redoModelChange, undoModelChange])

  useEffect(() => {
    if (!selectedNode) {
      setSourcePattern('')
      sourcePatternSyncRef.current = { nodeId: null, pattern: '' }
      return
    }
    const lastSynced = sourcePatternSyncRef.current
    if (lastSynced?.nodeId === selectedNode.id && lastSynced.pattern === selectedSourcePattern) {
      return
    }
    setSourcePattern(selectedSourcePattern)
    sourcePatternSyncRef.current = {
      nodeId: selectedNode.id,
      pattern: selectedSourcePattern
    }
  }, [selectedNode, selectedSourcePattern])

  useEffect(() => {
    setTargetNodeId('')
  }, [selectedNodeId])

  useEffect(() => {
    if (
      currentParentKind !== 'component' ||
      selectedNodeId ||
      selectedEdgeId ||
      codeLevelNodes.length === 0
    ) {
      return
    }
    const fallbackNodeId =
      codeLevelNodes.find((node) => node.id === selectedNodeIdRef.current)?.id ??
      codeLevelNodes[0]?.id
    if (!fallbackNodeId) {
      return
    }
    selectedNodeIdRef.current = fallbackNodeId
    setSelectedNodeId(fallbackNodeId)
  }, [codeLevelNodes, currentParentKind, selectedEdgeId, selectedNodeId])

  useEffect(() => {
    if (selectedNodeId || selectedEdgeId || architectureMode !== 'topology' || !model) {
      return
    }
    const lastCodeLevelParentId = lastCodeLevelParentIdRef.current
    if (!lastCodeLevelParentId) {
      return
    }
    const lastParent = model.nodes.find((node) => node.id === lastCodeLevelParentId)
    if (!lastParent || lastParent.data.kind !== 'component') {
      return
    }
    const children = model.nodes.filter((node) => node.parentId === lastCodeLevelParentId)
    if (children.length === 0) {
      return
    }
    const nextExpandedPath = [
      ...buildAncestorPath(model, lastCodeLevelParentId),
      lastCodeLevelParentId
    ]
    const fallbackNodeId =
      children.find((node) => node.id === selectedNodeIdRef.current)?.id ?? children[0]!.id
    selectedNodeIdRef.current = fallbackNodeId
    setExpandedPath((current) =>
      stringArraysEqual(current, nextExpandedPath) ? current : nextExpandedPath
    )
    setSelectedNodeId(fallbackNodeId)
  }, [architectureMode, model, selectedEdgeId, selectedNodeId])

  const addNodeForParent = useCallback(
    async (parentNode: ArchitectureDiagramNode | null) => {
      if (!model || editingLocked) {
        return
      }
      const kind = nextKindForParent(parentNode)
      if (kind === 'operation' || kind === 'process' || kind === 'model') {
        setMessage('Code-level symbols require a source file before they can be added.')
        return
      }
      const sameKindCount = model.nodes.filter((node) => node.data.kind === kind).length
      const name = `${kind[0].toUpperCase()}${kind.slice(1)} ${sameKindCount + 1}`
      const item =
        kind === 'system'
          ? { name, description: '' }
          : { parent_id: parentNode?.id, name, description: '' }
      try {
        const result = await executeArchitectureWrite(
          `scryer.${kind}.add`,
          { items: [item] },
          `Added ${name}`
        )
        const addedId = firstAddedId(result)
        setSelectedEdgeId(null)
        setSelectedGroupId(null)
        if (parentNode && !parentNode.data.external && isExpandableKind(parentNode.data.kind)) {
          setExpandedPath((current) =>
            current.at(-1) === parentNode.id ? current : [...current, parentNode.id]
          )
        }
        if (addedId) {
          selectedNodeIdRef.current = addedId
          setSelectedNodeId(addedId)
        }
      } catch (addError) {
        const text = addError instanceof Error ? addError.message : String(addError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, model]
  )

  const addNode = useCallback(async () => {
    await addNodeForParent(selectedNode)
  }, [addNodeForParent, selectedNode])

  const addNodeAtCurrentLevel = useCallback(async () => {
    await addNodeForParent(currentParent)
  }, [addNodeForParent, currentParent])

  const persistNodePatchById = useCallback(
    async (nodeId: string, patch: Partial<ArchitectureDiagramNode['data']>) => {
      const current = modelRef.current ?? model
      if (!current || editingLocked) {
        return
      }
      const target = current.nodes.find((node) => node.id === nodeId)
      if (!target) {
        return
      }
      const codeLevelPath = isCodeLevelKind(target.data.kind)
        ? buildAncestorPath(current, nodeId)
        : null
      const epoch = viewMutationEpochRef.current
      if (
        fingerprintArchitectureModel(current) !==
        fingerprintArchitectureModel({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
          )
        })
      ) {
        const history = pushArchitectureUndoSnapshot(undoStackRef.current, current, {
          batchStartedAt: historyBatchStartedAtRef.current,
          now: Date.now()
        })
        undoStackRef.current = history.stack
        historyBatchStartedAtRef.current = history.batchStartedAt
        redoStackRef.current = []
        setHistoryRevision((revision) => revision + 1)
      }
      const input = nodeUpdateInputFromDiagramPatch(nodeId, patch)
      if (!input) {
        return
      }
      try {
        const result = await enqueueArchitectureWrite(async () => {
          if (viewMutationEpochRef.current !== epoch) {
            return null
          }
          return (await window.api.architecture.executeScryerOperation({
            projectPath,
            operationId: 'scryer.node.update',
            input
          })) as ArchitectureOperationEnvelope
        })
        if (!result) {
          return
        }
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        if (viewMutationEpochRef.current !== epoch) {
          return
        }
        nodeDraftsRef.current.delete(nodeId)
        await loadModel('model')
        if (codeLevelPath) {
          setExpandedPath(codeLevelPath)
          selectedNodeIdRef.current = nodeId
          selectedEdgeIdRef.current = null
          setSelectedNodeId(nodeId)
          setSelectedEdgeId(null)
          setSelectedGroupId(null)
          setTotalSelected(1)
        }
        setMessage(`Saved ${target.data.name}`)
      } catch (patchError) {
        const text = patchError instanceof Error ? patchError.message : String(patchError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, enqueueArchitectureWrite, loadModel, model, projectPath]
  )

  const updateSelectedNode = useCallback(
    async (patch: Partial<ArchitectureDiagramNode['data']>) => {
      if (!selectedNode) {
        return
      }
      await persistNodePatchById(selectedNode.id, patch)
    },
    [persistNodePatchById, selectedNode]
  )

  const updateSelectedNodeDraft = useCallback(
    (nodeId: string, patch: Partial<ArchitectureDiagramNode['data']>) => {
      nodeDraftsRef.current.set(nodeId, {
        ...nodeDraftsRef.current.get(nodeId),
        ...patch
      })
      const current = visibleModelRef.current ?? modelRef.current
      if (!current) {
        return
      }
      const nextModel = modelWithNodeDrafts(current, nodeDraftsRef.current)
      visibleModelRef.current = nextModel
      setModel(nextModel)
    },
    []
  )

  const selectNode = useCallback((nodeId: string | null) => {
    selectedNodeIdRef.current = nodeId
    setSelectedNodeId(nodeId)
    if (nodeId) {
      setSelectedGroupId(null)
    }
    setMultiSelectedNodeIds((current) => (current.length === 0 ? current : []))
    setTotalSelected(nodeId ? 1 : 0)
    if (nodeId) {
      selectedEdgeIdRef.current = null
      setSelectedEdgeId(null)
    }
  }, [])

  const selectEdge = useCallback((edgeId: string | null) => {
    selectedEdgeIdRef.current = edgeId
    setSelectedEdgeId(edgeId)
    if (edgeId) {
      setSelectedGroupId(null)
    }
    setMultiSelectedNodeIds((current) => (current.length === 0 ? current : []))
    setTotalSelected(edgeId ? 1 : 0)
    if (edgeId) {
      selectedNodeIdRef.current = null
      setSelectedNodeId(null)
    }
  }, [])

  const selectManyNodes = useCallback((nodeIds: string[], selectedCount: number) => {
    setMultiSelectedNodeIds((current) => (stringArraysEqual(current, nodeIds) ? current : nodeIds))
    setTotalSelected(selectedCount)
    if (nodeIds.length >= 2) {
      setSelectedNodeId(null)
      setSelectedEdgeId(null)
      setSelectedGroupId(null)
    }
  }, [])

  const updateSelectedEdge = useCallback(
    async (patch: { label?: string; method?: string }) => {
      if (!modelRef.current || !selectedEdge || editingLocked) {
        return
      }
      try {
        await executeArchitectureWrite(
          'scryer.link.update',
          { links: [{ link_id: selectedEdge.id, ...patch }] },
          `Saved ${selectedEdge.id}`
        )
      } catch (edgeError) {
        const text = edgeError instanceof Error ? edgeError.message : String(edgeError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, selectedEdge]
  )

  const saveSourcePattern = useCallback(
    async (rawPattern: string) => {
      if (!selectedNode || editingLocked) {
        return
      }
      const pattern = rawPattern.trim()
      try {
        await executeArchitectureWrite(
          'scryer.source.update',
          {
            boundaries: [
              {
                node_id: selectedNode.id,
                sources: pattern ? [{ pattern }] : []
              }
            ]
          },
          `Saved source boundary for ${selectedNode.data.name}`
        )
      } catch (sourceError) {
        const text = sourceError instanceof Error ? sourceError.message : String(sourceError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, selectedNode]
  )

  const saveSourceLocations = useCallback(
    async (nodeId: string, locations: ArchitectureSourceLocation[]) => {
      const current = modelRef.current ?? model
      if (!current || editingLocked) {
        return
      }
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      const input =
        node && (node.data.properties?.length ?? 0) > 0
          ? {
              schemas: [
                {
                  node_id: nodeId,
                  locations: sourceMapLocationsFromRows(locations)
                }
              ]
            }
          : {
              boundaries: [
                {
                  node_id: nodeId,
                  sources: boundarySourcesFromLocations(locations)
                }
              ]
            }
      try {
        await executeArchitectureWrite(
          'scryer.source.update',
          input,
          `Saved source for ${node?.data.name ?? nodeId}`
        )
      } catch (sourceError) {
        const text = sourceError instanceof Error ? sourceError.message : String(sourceError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, model]
  )

  const addEdge = useCallback(
    async (requestedSourceNodeId?: string, requestedTargetNodeId?: string) => {
      const current = modelRef.current ?? model
      const sourceNodeId = requestedSourceNodeId ?? selectedNode?.id
      const nextTargetNodeId = requestedTargetNodeId ?? targetNodeId
      if (!current || editingLocked) {
        return
      }
      if (!sourceNodeId || !nextTargetNodeId) {
        setMessage('Select a relationship target')
        return
      }
      if (sourceNodeId === nextTargetNodeId) {
        setMessage('Choose a different relationship target')
        return
      }
      const sourceNode = current.nodes.find((node) => node.id === sourceNodeId)
      const targetNode = current.nodes.find((node) => node.id === nextTargetNodeId)
      if (!sourceNode || !targetNode) {
        setMessage('Relationship source or target is no longer available')
        return
      }
      const id = `edge-${sourceNodeId}-${nextTargetNodeId}`
      if (current.links.some((edge) => edge.id === id)) {
        setMessage('Edge already exists')
        return
      }
      try {
        await executeArchitectureWrite(
          'scryer.link.add',
          { links: [{ src: sourceNodeId, dst: nextTargetNodeId, label: 'depends on' }] },
          'Saved architecture link'
        )
      } catch (edgeError) {
        const text = edgeError instanceof Error ? edgeError.message : String(edgeError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, model, selectedNode, targetNodeId]
  )

  const deleteSelected = useCallback(async () => {
    if (!model || !selectedNode || editingLocked) {
      return
    }
    try {
      await executeArchitectureWrite(
        'scryer.node.delete',
        { node_ids: [selectedNode.id] },
        `Deleted ${selectedNode.data.name}`
      )
      setSelectedNodeId(null)
      setSelectedEdgeId(null)
    } catch (deleteError) {
      const text = deleteError instanceof Error ? deleteError.message : String(deleteError)
      setError(text)
      toast.error(text)
    }
  }, [editingLocked, executeArchitectureWrite, model, selectedNode])

  const deleteSelectedEdge = useCallback(async () => {
    if (!model || !selectedEdge || editingLocked) {
      return
    }
    try {
      await executeArchitectureWrite(
        'scryer.link.delete',
        { link_ids: [selectedEdge.id] },
        `Deleted ${selectedEdge.id}`
      )
      setSelectedEdgeId(null)
    } catch (edgeError) {
      const text = edgeError instanceof Error ? edgeError.message : String(edgeError)
      setError(text)
      toast.error(text)
    }
  }, [editingLocked, executeArchitectureWrite, model, selectedEdge])

  const deleteEdgeById = useCallback(
    async (edgeId: string) => {
      const current = modelRef.current
      if (!current || editingLocked) {
        return
      }
      const target = current.links.find((edge) => edge.id === edgeId)
      try {
        await executeArchitectureWrite(
          'scryer.link.delete',
          { link_ids: [edgeId] },
          target ? `Deleted ${target.id}` : 'Deleted architecture link'
        )
        setSelectedEdgeId((selected) => (selected === edgeId ? null : selected))
      } catch (edgeError) {
        const text = edgeError instanceof Error ? edgeError.message : String(edgeError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite]
  )

  const addCodeLevelNode = useCallback(
    async (kind: ArchitectureDiagramKind) => {
      const current = modelRef.current
      if (!current || !currentParent || editingLocked) {
        return
      }
      const defaultName =
        kind === 'model'
          ? `Model${codeLevelNodes.length + 1}`
          : `${kind}${codeLevelNodes.length + 1}`
      try {
        const result = await executeArchitectureWrite(
          'scryer.symbol.add',
          {
            items: [
              {
                parent_id: currentParent.id,
                name: defaultName,
                description: '',
                appearance: { symbolKind: kind },
                ...(kind === 'model' ? { properties: [] } : {})
              }
            ]
          },
          `Added ${kind}`
        )
        const addedId = firstAddedId(result)
        setExpandedPath([...buildAncestorPath(current, currentParent.id), currentParent.id])
        if (addedId) {
          selectedNodeIdRef.current = addedId
          setSelectedNodeId(addedId)
          selectedEdgeIdRef.current = null
          setSelectedEdgeId(null)
          setSelectedGroupId(null)
          setTotalSelected(1)
        }
      } catch (addError) {
        const text = addError instanceof Error ? addError.message : String(addError)
        setError(text)
        toast.error(text)
      }
    },
    [codeLevelNodes.length, currentParent, editingLocked, executeArchitectureWrite]
  )

  const deleteNodeById = useCallback(
    async (nodeId: string) => {
      const current = modelRef.current
      if (!current || editingLocked) {
        return
      }
      const target = current.nodes.find((node) => node.id === nodeId)
      try {
        await executeArchitectureWrite(
          'scryer.node.delete',
          { node_ids: [nodeId] },
          target ? `Deleted ${target.data.name}` : 'Deleted node'
        )
        setSelectedNodeId((selected) => (selected === nodeId ? null : selected))
        setSelectedEdgeId(null)
      } catch (deleteError) {
        const text = deleteError instanceof Error ? deleteError.message : String(deleteError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite]
  )

  const runDriftCheck = useCallback(async () => {
    if (!projectPath) {
      return
    }
    const report = await window.api.architecture.checkDrift({ projectPath })
    setDrift(report)
    setSyncMessage(
      report.nodes.length || report.structureChanged ? 'Code drift detected' : 'Model is synced'
    )
  }, [projectPath])

  const markSynced = useCallback(async () => {
    if (!projectPath) {
      return
    }
    await window.api.architecture.markSynced({ projectPath })
    setDrift({ nodes: [], structureChanged: false })
    setSyncMessage('Marked architecture as synced')
  }, [projectPath])

  const navigateToNode = useCallback(
    (nodeId: string) => {
      const current = modelRef.current ?? model
      if (!current || !current.nodes.some((node) => node.id === nodeId)) {
        return
      }
      setArchitectureMode('topology')
      setExpandedPath(buildAncestorPath(current, nodeId))
      setSelectedNodeId(nodeId)
      setSelectedEdgeId(null)
    },
    [model]
  )

  const drillIntoNode = useCallback(
    (nodeId: string) => {
      const current = modelRef.current ?? model
      const node = current?.nodes.find((entry) => entry.id === nodeId)
      if (!current || !node || !isExpandableKind(node.data.kind)) {
        return
      }
      setArchitectureMode('topology')
      setExpandedPath([...buildAncestorPath(current, nodeId), nodeId])
      setSelectedNodeId(null)
      setSelectedEdgeId(null)
    },
    [model]
  )

  const updateGroups = useCallback(
    (updater: (prev: ArchitectureGroup[]) => ArchitectureGroup[]) => {
      const current = modelRef.current
      if (!current || editingLocked) {
        return
      }
      const nextGroups = updater(current.groups ?? [])
      void executeArchitectureWrite(
        'scryer.group.set',
        { data: nextGroups },
        'Saved architecture groups'
      ).catch((groupError: unknown) => {
        const text = groupError instanceof Error ? groupError.message : String(groupError)
        setError(text)
        toast.error(text)
      })
      setSelectedGroupId((selected) =>
        selected && nextGroups.some((group) => group.id === selected) ? selected : null
      )
    },
    [editingLocked, executeArchitectureWrite]
  )

  const createGroupFromSelection = useCallback(
    async (name: string) => {
      const current = modelRef.current
      if (!current || editingLocked || multiSelectedNodeIds.length < 2) {
        return
      }
      try {
        await executeArchitectureWrite(
          'scryer.group.add',
          {
            items: [
              {
                parent_id: currentParentId,
                name: name.trim() || 'New group',
                member_ids: multiSelectedNodeIds
              }
            ]
          },
          `Created ${name.trim() || 'New group'}`
        )
        setMultiSelectedNodeIds([])
        setTotalSelected(0)
      } catch (groupError) {
        const text = groupError instanceof Error ? groupError.message : String(groupError)
        setError(text)
        toast.error(text)
      }
    },
    [currentParentId, editingLocked, executeArchitectureWrite, multiSelectedNodeIds]
  )

  const addSelectionToGroup = useCallback(
    async (groupId: string) => {
      const current = modelRef.current
      if (!current || editingLocked || multiSelectedNodeIds.length < 2) {
        return
      }
      const target = (current.groups ?? []).find((group) => group.id === groupId)
      if (!target) {
        return
      }
      try {
        await executeArchitectureWrite(
          'scryer.group.update',
          {
            items: [
              { group_id: groupId, member_ids: [...target.memberIds, ...multiSelectedNodeIds] }
            ]
          },
          'Added selected nodes to group'
        )
        setSelectedGroupId(groupId)
        setMultiSelectedNodeIds([])
        setTotalSelected(0)
      } catch (groupError) {
        const text = groupError instanceof Error ? groupError.message : String(groupError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, multiSelectedNodeIds]
  )

  const patchSelectedGroup = useCallback(
    async (patch: Partial<ArchitectureGroup>) => {
      const current = modelRef.current
      if (!current || !selectedGroup || editingLocked) {
        return
      }
      try {
        await executeArchitectureWrite(
          'scryer.group.update',
          {
            items: [
              {
                group_id: selectedGroup.id,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.description !== undefined ? { description: patch.description } : {}),
                ...(patch.memberIds !== undefined ? { member_ids: patch.memberIds } : {})
              }
            ]
          },
          `Saved ${selectedGroup.name}`
        )
      } catch (groupError) {
        const text = groupError instanceof Error ? groupError.message : String(groupError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, selectedGroup]
  )

  const removeSelectedGroupMember = useCallback(
    async (nodeId: string) => {
      const current = modelRef.current
      if (!current || !selectedGroup || editingLocked) {
        return
      }
      try {
        await executeArchitectureWrite(
          'scryer.group.update',
          {
            items: [
              {
                group_id: selectedGroup.id,
                member_ids: selectedGroup.memberIds.filter((memberId) => memberId !== nodeId)
              }
            ]
          },
          `Saved ${selectedGroup.name}`
        )
      } catch (groupError) {
        const text = groupError instanceof Error ? groupError.message : String(groupError)
        setError(text)
        toast.error(text)
      }
    },
    [editingLocked, executeArchitectureWrite, selectedGroup]
  )

  const deleteSelectedGroup = useCallback(async () => {
    const current = modelRef.current
    if (!current || !selectedGroup || editingLocked) {
      return
    }
    try {
      await executeArchitectureWrite(
        'scryer.group.delete',
        { group_id: selectedGroup.id },
        `Deleted ${selectedGroup.name}`
      )
      setSelectedGroupId(null)
    } catch (groupError) {
      const text = groupError instanceof Error ? groupError.message : String(groupError)
      setError(text)
      toast.error(text)
    }
  }, [editingLocked, executeArchitectureWrite, selectedGroup])

  const toggleLock = useCallback(async () => {
    if (!projectPath) {
      return
    }
    const nextActive = !implementing
    try {
      const result = (await window.api.architecture.callTool({
        projectPath,
        call: {
          toolName: 'set_implementing',
          arguments: { active: nextActive }
        }
      })) as { ok?: boolean; content?: string }
      if (result.ok === false) {
        throw new Error(result.content ?? 'Could not toggle drift detection lock.')
      }
      setImplementing(nextActive)
      setSyncMessage(nextActive ? 'Drift detection locked' : 'Drift detection resumed')
      if (!nextActive) {
        await runDriftCheck()
      }
    } catch (syncError) {
      const text = syncError instanceof Error ? syncError.message : String(syncError)
      setSyncStatus('error')
      setSyncMessage(text)
      toast.error(text)
    }
  }, [implementing, projectPath, runDriftCheck])

  const openSourceLocation = useCallback(
    async (location: ArchitectureSourceLocation) => {
      if (!projectPath) {
        return
      }
      try {
        const files = await window.api.fs.listFiles({ rootPath: projectPath })
        const target = resolveSourceLocationTarget({ projectPath, files, location })
        if ('error' in target) {
          setError(target.error)
          toast.error(target.error)
          return
        }
        openFile(
          {
            filePath: target.absolutePath,
            relativePath: target.relativePath,
            worktreeId: workspace.worktreeId,
            language: detectLanguage(target.relativePath),
            mode: 'edit'
          },
          {
            preview: true,
            targetGroupId: useAppStore.getState().activeGroupIdByWorktree?.[workspace.worktreeId],
            recordReplacedPreview: true
          }
        )
        if (target.line !== undefined) {
          setPendingEditorReveal(null)
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setPendingEditorReveal({
                filePath: target.absolutePath,
                line: target.line ?? 1,
                column: 1,
                matchLength: 0
              })
            })
          })
        }
      } catch (sourceError) {
        const text = sourceError instanceof Error ? sourceError.message : String(sourceError)
        setError(text)
        toast.error(text)
      }
    },
    [openFile, projectPath, setPendingEditorReveal, workspace.worktreeId]
  )

  const launchArchitectureAgentPrompt = useCallback(
    (prompt: string, failureMessage: string) => {
      const agent = activeAgent?.name ?? 'codex'
      const launched = launchAgentInNewTab({
        agent,
        worktreeId: workspace.worktreeId,
        prompt,
        launchSource: 'unknown'
      })
      if (!launched) {
        throw new Error(failureMessage)
      }
      return launched
    },
    [activeAgent, workspace.worktreeId]
  )

  const startInitialModel = useCallback(async () => {
    if (!projectPath) {
      return
    }
    if (!aiRunSession.beginRun('build', 'Preparing Build with AI prompt')) {
      return
    }
    try {
      await flushPendingArchitectureViewWork()
      const result = await window.api.architecture.prepareInitialModelPrompt({
        projectPath,
        modelName: activeModelNameRef.current
      })
      launchArchitectureAgentPrompt(
        result.prompt,
        'Could not launch an Orca agent terminal for architecture modeling.'
      )
      setMessage('Build with AI prompt sent')
      aiRunSession.markRun('build', 'done', 'Build with AI prompt sent')
    } catch (aiError) {
      const text = aiError instanceof Error ? aiError.message : String(aiError)
      setError(text)
      aiRunSession.markRun('build', 'failed', text)
      toast.error(text)
    }
  }, [
    activeModelNameRef,
    aiRunSession,
    launchArchitectureAgentPrompt,
    projectPath,
    flushPendingArchitectureViewWork
  ])

  const fillNodeWithAi = useCallback(
    async (nodeId: string) => {
      if (!projectPath) {
        return
      }
      if (!aiRunSession.beginRun('fill', 'Preparing Fill with AI prompt')) {
        return
      }
      try {
        await flushPendingArchitectureViewWork()
        const result = await window.api.architecture.prepareNodeFillPrompt({
          projectPath,
          modelName: activeModelNameRef.current,
          nodeId
        })
        launchArchitectureAgentPrompt(
          result.prompt,
          'Could not launch an Orca agent terminal for architecture node fill.'
        )
        setMessage('Fill with AI prompt sent')
        aiRunSession.markRun('fill', 'done', 'Fill with AI prompt sent')
      } catch (aiError) {
        const text = aiError instanceof Error ? aiError.message : String(aiError)
        setError(text)
        aiRunSession.markRun('fill', 'failed', text)
        toast.error(text)
      }
    },
    [
      activeModelNameRef,
      aiRunSession,
      launchArchitectureAgentPrompt,
      projectPath,
      flushPendingArchitectureViewWork
    ]
  )

  const startAdvisorReview = useCallback(async () => {
    if (!projectPath) {
      return
    }
    if (!aiRunSession.beginRun('review', 'Preparing advisor review prompt')) {
      return
    }
    try {
      await flushPendingArchitectureViewWork()
      const result = await window.api.architecture.prepareAdvisorPrompt({
        projectPath,
        modelName: activeModelNameRef.current
      })
      launchArchitectureAgentPrompt(
        result.prompt,
        'Could not launch an Orca agent terminal for architecture review.'
      )
      setMessage('Advisor review prompt sent')
      aiRunSession.markRun('review', 'done', 'Advisor review prompt sent')
    } catch (aiError) {
      const text = aiError instanceof Error ? aiError.message : String(aiError)
      setError(text)
      aiRunSession.markRun('review', 'failed', text)
      toast.error(text)
    }
  }, [
    activeModelNameRef,
    aiRunSession,
    launchArchitectureAgentPrompt,
    projectPath,
    flushPendingArchitectureViewWork
  ])

  const writeMcpConfig = useCallback(async () => {
    if (!projectPath) {
      return
    }
    try {
      const result = await window.api.architecture.writeMcpConfig({ projectPath })
      setMessage(`Wrote MCP config: ${result.claudePath} and ${result.codexPath}`)
    } catch (configError) {
      const text = configError instanceof Error ? configError.message : String(configError)
      setError(text)
      toast.error(text)
    }
  }, [projectPath])

  const resolveActiveSyncAgentRunId = useCallback(async (): Promise<string | null> => {
    const localAgentRunId = syncTerminalTabIdRef.current ?? syncTerminalTabId
    if (localAgentRunId) {
      return localAgentRunId
    }
    if (!projectPath) {
      return null
    }
    const session = await window.api.architecture.readEditSession({ projectPath }).catch(() => null)
    return session?.activeLease?.agentRunId ?? null
  }, [projectPath, syncTerminalTabId])

  const startSync = useCallback(async () => {
    if (!projectPath || syncStatus === 'running') {
      return
    }
    if (!aiRunSession.beginRun('sync', 'Preparing architecture sync prompt')) {
      return
    }
    let began = false
    try {
      setError('')
      await flushPendingArchitectureViewWork()
      syncResolutionRef.current = null
      setCompletionGate(null)
      setSyncStatus('running')
      setSyncMessage(null)
      setSyncLog(['Preparing architecture sync prompt'])
      const result = await window.api.architecture.beginSync({
        projectPath,
        modelName: activeModelNameRef.current
      })
      began = true
      setImplementing(true)
      setDrift(result.drift)
      const agent = activeAgent?.name ?? 'codex'
      const launched = launchAgentInNewTab({
        agent,
        worktreeId: workspace.worktreeId,
        prompt: result.prompt,
        launchSource: 'unknown'
      })
      if (!launched) {
        throw new Error('Could not launch an Orca agent terminal for architecture sync.')
      }
      if (!launched.tabId) {
        throw new Error('Architecture sync agent launch did not return a terminal tab id.')
      }
      await window.api.architecture.beginEditSession({
        projectPath,
        agentRunId: launched.tabId
      })
      aiRunSession.markRun('sync', 'running', 'Architecture sync is running')
      syncTerminalHadPtyRef.current = false
      syncTerminalTabIdRef.current = launched.tabId
      setSyncTerminalTabId(launched.tabId)
      trackArchitectureSyncTerminal(projectPath, launched.tabId, () => {
        if (autoFinishingSyncRef.current) {
          return
        }
        autoFinishingSyncRef.current = true
        setSyncLog((current) => [
          ...current,
          'Agent reported done. Checking Scryer completion gate.'
        ])
        setSyncMessage('Agent reported done. Checking Scryer completion gate.')
        void finishSyncRef.current().finally(() => {
          autoFinishingSyncRef.current = false
        })
      })
      setSyncLog((current) => [...current, `Sync prompt sent to ${agent}`])
    } catch (syncError) {
      if (began) {
        const agentRunId = syncTerminalTabIdRef.current
        if (agentRunId) {
          await window.api.architecture
            .cancelEditSession({ projectPath, agentRunId })
            .catch(() => undefined)
        }
        await window.api.architecture.cancelSync({ projectPath }).catch(() => null)
      }
      setSyncStatus('error')
      setImplementing(false)
      syncTerminalTabIdRef.current = null
      const text = syncError instanceof Error ? syncError.message : String(syncError)
      setError(text)
      setSyncMessage(text)
      aiRunSession.markRun('sync', 'failed', text)
      toast.error(text)
    }
  }, [
    activeAgent,
    activeModelNameRef,
    aiRunSession,
    projectPath,
    syncStatus,
    workspace.worktreeId,
    flushPendingArchitectureViewWork
  ])

  const cancelSync = useCallback(async () => {
    if (!projectPath) {
      return
    }
    if (syncResolutionRef.current) {
      return
    }
    syncResolutionRef.current = 'cancel'
    try {
      const agentRunId = await resolveActiveSyncAgentRunId()
      if (agentRunId) {
        await window.api.architecture
          .cancelEditSession({ projectPath, agentRunId })
          .catch(() => undefined)
      }
      await window.api.architecture.cancelSync({ projectPath })
      await loadModel('model')
      setChangedNodeIds(new Set())
      setNodeDiffs(new Map())
      setSelectedEdgeId(null)
      setSyncStatus('idle')
      setSyncLog([])
      syncTerminalTabIdRef.current = null
      setSyncTerminalTabId(null)
      setCompletionGate(null)
      setImplementing(false)
      setSyncMessage('Restored pre-sync architecture model')
      aiRunSession.markRun('sync', 'cancelled', 'Architecture sync cancelled')
    } catch (syncError) {
      const text = syncError instanceof Error ? syncError.message : String(syncError)
      setSyncStatus('error')
      setSyncMessage(text)
      setError(text)
      aiRunSession.markRun('sync', 'failed', text)
      toast.error(text)
    } finally {
      syncResolutionRef.current = null
    }
  }, [aiRunSession, loadModel, projectPath, resolveActiveSyncAgentRunId])

  const finishSync = useCallback(async () => {
    if (!projectPath) {
      return
    }
    if (syncResolutionRef.current) {
      return
    }
    syncResolutionRef.current = 'finish'
    try {
      let gate: ScryerCompletionGateResult | null = null
      const agentRunId = await resolveActiveSyncAgentRunId()
      if (agentRunId) {
        gate = await window.api.architecture.completeEditSession({
          projectPath,
          agentRunId
        })
      }
      await window.api.architecture.finishSync({ projectPath })
      if (gate) {
        setCompletionGate(gate)
      }
      setSyncStatus('idle')
      setSyncLog([])
      syncTerminalTabIdRef.current = null
      setSyncTerminalTabId(null)
      setImplementing(false)
      setDrift({ nodes: [], structureChanged: false })
      setChangedNodeIds(new Set())
      setNodeDiffs(new Map())
      setSyncMessage('Architecture sync finished')
      aiRunSession.markRun('sync', 'done', 'Architecture sync finished')
    } catch (syncError) {
      const text = syncError instanceof Error ? syncError.message : String(syncError)
      setSyncStatus('error')
      setSyncMessage(text)
      setError(text)
      aiRunSession.markRun('sync', 'failed', text)
      toast.error(text)
    } finally {
      syncResolutionRef.current = null
    }
  }, [aiRunSession, projectPath, resolveActiveSyncAgentRunId])

  useEffect(() => {
    finishSyncRef.current = finishSync
  }, [finishSync])

  const dismissSyncMessage = useCallback(() => {
    setSyncMessage(null)
    if (syncStatus === 'error') {
      setSyncStatus('idle')
    }
  }, [syncStatus])

  useEffect(() => {
    if (syncStatus !== 'running' || !syncTerminalTabId) {
      syncTerminalPtyIdsRef.current = new Set()
      return
    }
    if (syncTerminalPtyIds.length === 0) {
      return
    }
    const next = new Set(syncTerminalPtyIdsRef.current)
    for (const ptyId of syncTerminalPtyIds) {
      next.add(ptyId)
    }
    syncTerminalPtyIdsRef.current = next
  }, [syncStatus, syncTerminalPtyIds, syncTerminalPtyIdsKey, syncTerminalTabId])

  useEffect(() => {
    if (syncStatus !== 'running' || !syncTerminalTabId || !projectPath) {
      return
    }
    return window.api.pty.onExit(({ id, code }) => {
      if (!syncTerminalPtyIdsRef.current.has(id)) {
        return
      }
      syncTerminalPtyIdsRef.current.delete(id)
      if (code === 0) {
        if (autoFinishingSyncRef.current) {
          return
        }
        autoFinishingSyncRef.current = true
        setSyncLog((current) => [
          ...current,
          'Agent terminal exited cleanly. Finishing architecture sync.'
        ])
        setSyncMessage('Agent terminal exited cleanly. Finishing architecture sync.')
        void finishSync().finally(() => {
          autoFinishingSyncRef.current = false
        })
        return
      }

      syncTerminalHadPtyRef.current = false
      setSyncLog((current) => [
        ...current,
        `Agent terminal exited with code ${code}. Review model changes, then finish or cancel sync.`
      ])
      setSyncMessage(
        `Agent terminal exited with code ${code}. Review changes, then finish or cancel sync.`
      )
    })
  }, [finishSync, projectPath, syncStatus, syncTerminalTabId])

  useEffect(() => {
    if (syncStatus !== 'running' || !syncTerminalTabId) {
      syncTerminalHadPtyRef.current = false
      return
    }
    if (syncTerminalPtyCount > 0) {
      syncTerminalHadPtyRef.current = true
      return
    }
    if (!syncTerminalHadPtyRef.current) {
      return
    }
    if (autoFinishingSyncRef.current) {
      return
    }
    syncTerminalHadPtyRef.current = false
    setSyncLog((current) => [
      ...current,
      'Agent terminal exited. Review model changes, then finish or cancel sync.'
    ])
    setSyncMessage('Agent terminal exited. Review changes, then finish or cancel sync.')
  }, [syncStatus, syncTerminalPtyCount, syncTerminalTabId])

  const dismissNodeDiff = useCallback(
    (nodeId: string) => {
      setNodeDiffs((current) => {
        const currentNode = modelRef.current?.nodes.find((node) => node.id === nodeId)
        if (currentNode) {
          dismissedNodeDiffKeysRef.current.set(
            nodeDiffDismissalKey(activeModelNameRef.current, nodeId),
            fingerprintNodeData(currentNode.data)
          )
        }
        const next = new Map(current)
        next.delete(nodeId)
        setChangedNodeIds((changed) => {
          if (!changed.has(nodeId)) {
            return changed
          }
          const nextChanged = new Set(changed)
          nextChanged.delete(nodeId)
          return nextChanged
        })
        return next
      })
    },
    [activeModelNameRef]
  )

  return {
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
  }
}
