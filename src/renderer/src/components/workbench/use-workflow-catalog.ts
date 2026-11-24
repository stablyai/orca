import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import {
  WORKFLOW_PRESETS,
  resolveNodeLabel,
  resolvePresetDescription,
  resolvePresetLabel,
  useWorkflowSelectionStore,
  type WorkflowNodeDef,
  type WorkflowNodeKind,
  type WorkflowPreset
} from './workflow-presets'
import {
  buildSampleWorkflowYaml,
  loadRepoYamlWorkflows,
  serializeWorkflowYaml
} from './workflow-yaml'
import { getDefaultNodeTemplate } from './workflow-node-templates'
import { runWithBusyFlag } from '@/lib/run-with-busy-flag'

export function useWorkflowCatalog({
  rootPath,
  connectionId,
  activeWorktreeId,
  t
}: {
  rootPath: string | null
  connectionId: string | undefined
  activeWorktreeId: string | undefined
  t: (key: string, defaultValue: string) => string
}) {
  const [yamlWorkflows, setYamlWorkflows] = useState<WorkflowPreset[]>([])
  const selectedPresetId = useWorkflowSelectionStore((s) => s.selectedWorkflowId)
  const setSelectedPresetId = useWorkflowSelectionStore((s) => s.setSelectedWorkflowId)
  const hiddenPresetIds = useWorkflowSelectionStore((s) => s.hiddenPresetIds)
  const triggerWorkflowRefresh = useWorkflowSelectionStore((s) => s.triggerWorkflowRefresh)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [presetNodesOverride, setPresetNodesOverride] = useState<Record<string, WorkflowNodeDef[]>>(
    {}
  )

  const getPresetLabel = useCallback((p: WorkflowPreset) => resolvePresetLabel(p, t), [t])
  const getPresetDesc = useCallback((p: WorkflowPreset) => resolvePresetDescription(p, t), [t])
  const getNodeLabel = useCallback((n: WorkflowNodeDef) => resolveNodeLabel(n, t), [t])

  const refreshYamlWorkflows = useCallback(async () => {
    if (!rootPath) {
      setYamlWorkflows([])
      return
    }
    // Why: the busy reset lives in a module-level helper so the compiler can compile this callback.
    await runWithBusyFlag(setRefreshing, async () => {
      const loaded = await loadRepoYamlWorkflows(rootPath, connectionId)
      setYamlWorkflows(loaded)
      if (
        loaded.length > 0 &&
        !loaded.some((w) => w.id === selectedPresetId) &&
        !WORKFLOW_PRESETS.some((p) => p.id === selectedPresetId)
      ) {
        setSelectedPresetId(loaded[0].id)
      }
    })
  }, [connectionId, rootPath, selectedPresetId, setSelectedPresetId])

  useEffect(() => {
    void refreshYamlWorkflows()
  }, [refreshYamlWorkflows])

  const visiblePresets = useMemo(
    () => WORKFLOW_PRESETS.filter((p) => !hiddenPresetIds.includes(p.id)),
    [hiddenPresetIds]
  )

  const allWorkflows = useMemo(
    () => (yamlWorkflows.length > 0 ? [...yamlWorkflows, ...visiblePresets] : visiblePresets),
    [visiblePresets, yamlWorkflows]
  )

  const baseSelectedPreset = useMemo(
    () =>
      allWorkflows.find((p) => p.id === selectedPresetId) ?? allWorkflows[0] ?? WORKFLOW_PRESETS[0],
    [allWorkflows, selectedPresetId]
  )

  const selectedPreset = useMemo<WorkflowPreset>(() => {
    const overridden = presetNodesOverride[baseSelectedPreset.id]
    return overridden ? { ...baseSelectedPreset, nodes: overridden } : baseSelectedPreset
  }, [baseSelectedPreset, presetNodesOverride])

  const editingNode = useMemo(
    () => selectedPreset.nodes.find((n) => n.id === editingNodeId) ?? null,
    [editingNodeId, selectedPreset.nodes]
  )

  const persistNodes = useCallback(
    async (updatedNodes: WorkflowNodeDef[]) => {
      const normalized = updatedNodes.map((n) => ({
        ...n,
        labelKey: undefined,
        defaultLabel: getNodeLabel(n)
      }))
      if (selectedPreset.filePath) {
        const content = serializeWorkflowYaml(
          getPresetLabel(selectedPreset),
          getPresetDesc(selectedPreset),
          normalized
        )
        await window.api.fs.writeFile({ filePath: selectedPreset.filePath, content, connectionId })
        await refreshYamlWorkflows()
        triggerWorkflowRefresh()
      } else {
        setPresetNodesOverride((prev) => ({ ...prev, [selectedPreset.id]: normalized }))
      }
    },
    [
      connectionId,
      getNodeLabel,
      getPresetDesc,
      getPresetLabel,
      refreshYamlWorkflows,
      selectedPreset,
      triggerWorkflowRefresh
    ]
  )

  const openYamlInEditor = useCallback(
    (filePath: string, relativePath: string) => {
      const state = useAppStore.getState()
      state.openFile({
        filePath,
        relativePath,
        worktreeId: activeWorktreeId ?? '',
        language: 'yaml',
        mode: 'edit'
      })
      state.setActiveView('terminal')
    },
    [activeWorktreeId]
  )

  const handleOpenOrCreateYaml = useCallback(
    async (createNew: boolean) => {
      if (!rootPath) {
        return
      }
      if (!createNew && selectedPreset.filePath) {
        const rel = selectedPreset.filePath.slice(rootPath.length).replace(/^[\\/]+/, '')
        openYamlInEditor(selectedPreset.filePath, rel)
        return
      }
      const slug = createNew ? `workflow-${Date.now().toString().slice(-4)}` : selectedPreset.id
      const fileName = `${slug}.yml`
      const relPath = `.orca/workflows/${fileName}`
      const filePath = `${rootPath.replace(/[\\/]+$/, '')}/${relPath}`
      const yamlContent = createNew
        ? buildSampleWorkflowYaml(`Custom Workflow (${slug})`)
        : serializeWorkflowYaml(
            getPresetLabel(selectedPreset),
            getPresetDesc(selectedPreset),
            selectedPreset.nodes.map((n) => ({ ...n, defaultLabel: getNodeLabel(n) }))
          )
      await window.api.fs.writeFile({ filePath, content: yamlContent, connectionId })
      await refreshYamlWorkflows()
      triggerWorkflowRefresh()
      setSelectedPresetId(`yaml:${fileName}`)
      openYamlInEditor(filePath, relPath)
    },
    [
      connectionId,
      getNodeLabel,
      getPresetDesc,
      getPresetLabel,
      openYamlInEditor,
      refreshYamlWorkflows,
      rootPath,
      selectedPreset,
      setSelectedPresetId,
      triggerWorkflowRefresh
    ]
  )

  const handleInsertNode = useCallback(
    async (insertIndex: number, kind: WorkflowNodeKind) => {
      const tpl = getDefaultNodeTemplate(kind, t)
      const newNode: WorkflowNodeDef = {
        id: `${kind}-${Date.now().toString().slice(-4)}`,
        kind,
        defaultLabel: tpl.label,
        defaultDescription: tpl.description,
        instruction: tpl.instruction
      }
      const nextNodes = [...selectedPreset.nodes]
      nextNodes.splice(insertIndex, 0, newNode)
      await persistNodes(nextNodes)
      setEditingNodeId(newNode.id)
    },
    [persistNodes, selectedPreset.nodes, t]
  )

  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      if (selectedPreset.nodes.length <= 1) {
        return
      }
      const nextNodes = selectedPreset.nodes.filter((n) => n.id !== nodeId)
      await persistNodes(nextNodes)
      setEditingNodeId((prev) => (prev === nodeId ? null : prev))
    },
    [persistNodes, selectedPreset.nodes]
  )

  const handleMoveNode = useCallback(
    async (nodeId: string, direction: -1 | 1) => {
      const idx = selectedPreset.nodes.findIndex((n) => n.id === nodeId)
      const targetIdx = idx + direction
      if (idx === -1 || targetIdx < 0 || targetIdx >= selectedPreset.nodes.length) {
        return
      }
      const nextNodes = [...selectedPreset.nodes]
      const [moved] = nextNodes.splice(idx, 1)
      nextNodes.splice(targetIdx, 0, moved)
      await persistNodes(nextNodes)
    },
    [persistNodes, selectedPreset.nodes]
  )

  const handleSaveNodeConfig = useCallback(
    async (
      nodeId: string,
      patch: {
        label?: string
        kind?: WorkflowNodeDef['kind']
        shell?: WorkflowNodeDef['shell']
        agent?: string
        model?: string
        instruction?: string
      }
    ) => {
      const updatedNodes = selectedPreset.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              labelKey: undefined,
              defaultLabel: patch.label?.trim() || getNodeLabel(n),
              kind: patch.kind ?? n.kind,
              shell: patch.shell,
              agent: patch.agent,
              model: patch.model,
              instruction: patch.instruction
            }
          : n
      )
      await persistNodes(updatedNodes)
      setEditingNodeId(null)
    },
    [getNodeLabel, persistNodes, selectedPreset.nodes]
  )

  return {
    allWorkflows,
    selectedPreset,
    selectedPresetId,
    setSelectedPresetId,
    editingNodeId,
    setEditingNodeId,
    editingNode,
    refreshing,
    refreshYamlWorkflows,
    handleOpenOrCreateYaml,
    handleInsertNode,
    handleDeleteNode,
    handleMoveNode,
    handleSaveNodeConfig
  }
}
