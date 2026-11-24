import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, FileCode2, FolderOpen, Plus, RotateCcw, Square, Workflow } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useAppStore } from '@/store/index'
import { NativeChatPromptEditor } from '../native-chat/composer/editor/NativeChatPromptEditor'
import type { NativeChatComposerInput } from '../native-chat/composer/editor/native-chat-composer-input'
import { NativeChatComposerPrimaryButton } from '../native-chat/composer/controls/NativeChatComposerPrimaryButton'
import { AgentLaunchPicker } from '../agent/AgentLaunchPicker'
import { useAgentMenuObservation } from '../agent/launch-menu/use-new-tab-agent-menu-rows'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { WorkbenchAutomationBar, type AutomationStageState } from './workbench-automation-bar'
import { WorkflowNodeConfigStrip } from './workflow-node-config-strip'
import { WorkflowRunProgressCard } from './workflow-run-progress-card'
import { WorkflowYamlGuidePopover } from './WorkflowYamlGuidePopover'
import { WorkflowTargetFolderPicker } from './WorkflowTargetFolderPicker'
import { HarnessPolicyPopover } from './HarnessPolicyPopover'
import { HARNESS_POLICY_REL_PATH, loadHarnessPolicy, saveHarnessPolicy } from './harness-policy-io'
import {
  createHarnessPolicyFromPreset,
  type HarnessPolicy
} from '../../../../shared/harness/harness-policy'
import { useWorkflowRunner } from './use-workflow-runner'
import { useWorkflowCatalog } from './use-workflow-catalog'
import { useActiveRepo, useRepos } from '@/store/repos/use-repository-catalog'
import {
  resolveNodeDescription,
  resolveNodeLabel,
  resolvePresetLabel,
  useWorkflowSelectionStore,
  type WorkflowNodeDef,
  type WorkflowPreset
} from './workflow-presets'

const NO_IMAGES: readonly string[] = []

export default function WorkbenchPage(): React.JSX.Element {
  const t = useTranslate()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useAppStore((s) =>
    activeWorktreeId ? (s.getKnownWorktreeById(activeWorktreeId) ?? null) : null
  )
  const [selectedAgent, setSelectedAgent] = useState<AgentPickerEntry['agent'] | null>('claude')
  const [agentDraft, setAgentDraft] = useState<AgentPickerDraft | undefined>(undefined)
  const [requirement, setRequirement] = useState('')
  const [composerResetKey, setComposerResetKey] = useState(0)
  const composerInputRef = useRef<NativeChatComposerInput | null>(null)
  const composingRef = useRef(false)

  const getPresetLabel = useCallback((p: WorkflowPreset) => resolvePresetLabel(p, t), [t])
  const getNodeLabel = useCallback((n: WorkflowNodeDef) => resolveNodeLabel(n, t), [t])
  const getNodeDesc = useCallback((n: WorkflowNodeDef) => resolveNodeDescription(n, t), [t])

  const [harnessPolicy, setHarnessPolicy] = useState<HarnessPolicy>(() =>
    createHarnessPolicyFromPreset('standard')
  )
  const repos = useRepos()
  const activeRepo = useActiveRepo()
  const targetRepoId = useWorkflowSelectionStore((s) => s.targetRepoId)
  const targetDir = useWorkflowSelectionStore((s) => s.targetDir)
  const setTarget = useWorkflowSelectionStore((s) => s.setTarget)

  const selectedRepo = useMemo(() => {
    if (targetRepoId) {
      return repos.find((r) => r.id === targetRepoId) ?? null
    }
    if (targetDir) {
      return repos.find((r) => r.path === targetDir) ?? null
    }
    return activeRepo ?? null
  }, [activeRepo, repos, targetDir, targetRepoId])

  const rootPath = targetDir ?? activeWorktree?.path ?? selectedRepo?.path ?? null
  const connectionId = selectedRepo?.connectionId ?? undefined

  const { activeRun, start, retryFailed, stop, clearRun } = useWorkflowRunner(
    getNodeLabel,
    getNodeDesc,
    harnessPolicy,
    { repo: selectedRepo, dirPath: rootPath }
  )
  const agentObservation = useAgentMenuObservation(
    activeWorktree?.id ?? null,
    true,
    selectedRepo?.connectionId
      ? { kind: 'ssh', connectionId: selectedRepo.connectionId }
      : { kind: 'local', worktreeId: activeWorktree?.id }
  )

  useEffect(() => {
    void loadHarnessPolicy(rootPath, connectionId).then(setHarnessPolicy)
  }, [connectionId, rootPath])

  const handleChangePolicy = useCallback(
    (next: HarnessPolicy) => {
      setHarnessPolicy(next)
      void saveHarnessPolicy(next, rootPath, connectionId)
    },
    [connectionId, rootPath]
  )

  const handleEditHarnessYaml = useCallback(async () => {
    if (!rootPath) {
      return
    }
    const savedPath = await saveHarnessPolicy(harnessPolicy, rootPath, connectionId)
    if (!savedPath) {
      return
    }
    const state = useAppStore.getState()
    state.openFile({
      filePath: savedPath,
      relativePath: HARNESS_POLICY_REL_PATH,
      worktreeId: activeWorktree?.id ?? '',
      language: 'yaml',
      mode: 'edit'
    })
    state.setActiveView('terminal')
  }, [activeWorktree?.id, connectionId, harnessPolicy, rootPath])

  const handleOpenYamlGuideDoc = useCallback(() => {
    if (!rootPath) {
      return
    }
    const relativePath = 'docs/workbench-yaml-guide.md'
    const filePath = `${rootPath.replace(/[\\/]+$/, '')}/${relativePath}`
    const state = useAppStore.getState()
    state.openFile({
      filePath,
      relativePath,
      worktreeId: activeWorktree?.id ?? '',
      language: 'markdown',
      mode: 'markdown-preview'
    })
    state.setActiveView('terminal')
  }, [activeWorktree?.id, rootPath])

  const {
    selectedPreset,
    editingNodeId,
    setEditingNodeId,
    editingNode,
    handleOpenOrCreateYaml,
    handleInsertNode,
    handleDeleteNode,
    handleMoveNode,
    handleSaveNodeConfig
  } = useWorkflowCatalog({
    rootPath,
    connectionId,
    activeWorktreeId: activeWorktree?.id,
    t
  })

  const submitRequirement = useCallback(() => {
    const trimmed = requirement.trim()
    if (!trimmed || activeRun?.running) {
      return
    }
    start(selectedPreset, trimmed)
    setRequirement('')
    setComposerResetKey((k) => k + 1)
  }, [activeRun?.running, requirement, selectedPreset, start])

  const stageStates: AutomationStageState[] = useMemo(() => {
    if (activeRun && activeRun.presetId === selectedPreset.id) {
      return activeRun.nodes.map((n, idx) => {
        const def = selectedPreset.nodes[idx]
        return {
          id: n.nodeId,
          label: n.label,
          kind: def?.kind,
          shell: def?.shell,
          agent: def?.agent,
          model: def?.model,
          command: def?.kind === 'cli' ? def.instruction : undefined,
          status: n.status
        }
      })
    }
    return selectedPreset.nodes.map((n) => ({
      id: n.id,
      label: getNodeLabel(n),
      kind: n.kind,
      shell: n.shell,
      agent: n.agent,
      model: n.model,
      command: n.kind === 'cli' ? n.instruction : undefined,
      status: 'idle' as const
    }))
  }, [activeRun, getNodeLabel, selectedPreset])

  const isRunning = Boolean(activeRun?.running)
  const openWorktreeInTerminal = useCallback((worktreeId: string) => {
    activateAndRevealWorktree(worktreeId)
    useAppStore.getState().setActiveView('terminal')
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-chat-pane">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 scrollbar-sleek">
        <div className="mx-auto flex w-full max-w-(--chat-content-max-width) items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
            <Workflow className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">{getPresetLabel(selectedPreset)}</span>
            {selectedPreset.filePath && rootPath ? (
              <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">
                {selectedPreset.filePath.slice(rootPath.length).replace(/^[\\/]+/, '')}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5">
            <HarnessPolicyPopover
              policy={harnessPolicy}
              hasRepo={Boolean(rootPath)}
              onChangePolicy={handleChangePolicy}
              onEditYaml={() => void handleEditHarnessYaml()}
            />
            {rootPath ? (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={isRunning}
                  onClick={() => void handleOpenOrCreateYaml(false)}
                >
                  <FileCode2 className="size-3.5" />
                  {t('auto.components.workbench.flow.editYaml', 'Edit YAML')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={isRunning}
                  onClick={() => void handleOpenOrCreateYaml(true)}
                >
                  <Plus className="size-3.5" />
                  {t('auto.components.workbench.flow.newYaml', 'New YAML')}
                </Button>
                <WorkflowYamlGuidePopover
                  hasRepo={Boolean(rootPath)}
                  onOpenGuideDoc={handleOpenYamlGuideDoc}
                />
              </>
            ) : null}
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-1 flex-col justify-center gap-3">
          {activeRun ? (
            <WorkflowRunProgressCard
              activeRun={activeRun}
              onStop={stop}
              onRetry={() => retryFailed(selectedPreset)}
              onOpenWorktree={
                activeRun.worktreeId
                  ? () => openWorktreeInTerminal(activeRun.worktreeId!)
                  : undefined
              }
              onClose={clearRun}
            />
          ) : (
            <>
              <WorkbenchAutomationBar
                stages={stageStates}
                selectedNodeId={editingNodeId}
                onSelectNode={(nodeId) =>
                  setEditingNodeId((prev) => (prev === nodeId ? null : nodeId))
                }
                onInsertNode={(index, kind) => void handleInsertNode(index, kind)}
                onDeleteNode={(nodeId) => void handleDeleteNode(nodeId)}
              />

              {editingNode ? (
                <WorkflowNodeConfigStrip
                  key={`${selectedPreset.id}:${editingNode.id}`}
                  node={editingNode}
                  label={getNodeLabel(editingNode)}
                  canMoveLeft={selectedPreset.nodes.findIndex((n) => n.id === editingNode.id) > 0}
                  canMoveRight={
                    selectedPreset.nodes.findIndex((n) => n.id === editingNode.id) <
                    selectedPreset.nodes.length - 1
                  }
                  canDelete={selectedPreset.nodes.length > 1}
                  agentModel={agentObservation.model}
                  worktreeId={activeWorktree?.id}
                  hasYamlFile={Boolean(selectedPreset.filePath)}
                  onSave={(patch) => void handleSaveNodeConfig(editingNode.id, patch)}
                  onMove={(dir) => void handleMoveNode(editingNode.id, dir)}
                  onDelete={() => void handleDeleteNode(editingNode.id)}
                  onClose={() => setEditingNodeId(null)}
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="@container/composer-field shrink-0 bg-chat-pane">
        <div className="native-chat-composer-gutter pt-2 pb-4">
          <div className="relative mx-auto w-full max-w-(--chat-content-max-width)">
            <div
              className={cn(
                'group/composer native-chat-composer-card rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs [contain:paint]'
              )}
            >
              <NativeChatPromptEditor
                key={`workflow-prompt-${composerResetKey}`}
                scopeKey="workbench-workflow-prompt"
                imageRow={NO_IMAGES}
                inputRef={composerInputRef}
                isComposing={() => composingRef.current}
                initialValue=""
                disabled={isRunning}
                onChange={(input) => setRequirement(input.value)}
                onSelect={() => {}}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                onKeyDownCapture={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !composingRef.current &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    submitRequirement()
                  }
                }}
                placeholder={t(
                  'auto.components.workbench.flow.requirementPlaceholder',
                  'Describe your requirement or task (Enter to start)...'
                )}
                className={cn(
                  'w-full bg-transparent px-2 py-1 text-sm outline-none',
                  'min-h-12 max-h-[calc(8lh+0.5rem)] text-chat-foreground-strong placeholder:text-chat-foreground-faint',
                  'overflow-y-auto scrollbar-sleek',
                  '[&[contenteditable=false]]:cursor-not-allowed [&[contenteditable=false]]:opacity-50'
                )}
              />
              <div className="mt-1 flex items-center justify-between gap-2 px-1.5 pb-0.5">
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <AgentLaunchPicker
                    model={agentObservation.model}
                    worktreeId={activeWorktree?.id}
                    agent={selectedAgent}
                    value={agentDraft}
                    disabled={isRunning}
                    onPick={(agent, draft) => {
                      setSelectedAgent(agent)
                      setAgentDraft(draft)
                    }}
                  />
                  <WorkflowTargetFolderPicker
                    currentPath={rootPath}
                    currentLabel={selectedRepo?.displayName ?? null}
                    disabled={isRunning}
                    onSelectTarget={setTarget}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {activeRun?.worktreeId ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => void activateAndRevealWorktree(activeRun.worktreeId!)}
                    >
                      <FolderOpen className="size-3.5" />
                      {t('auto.components.workbench.flow.openWorktree', 'Open Worktree')}
                    </Button>
                  ) : null}
                  {activeRun?.error && !isRunning ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => retryFailed(selectedPreset)}
                    >
                      <RotateCcw className="size-3.5" />
                      {t('auto.components.workbench.flow.retryNode', 'Retry Node')}
                    </Button>
                  ) : null}
                  {isRunning ? (
                    <NativeChatComposerPrimaryButton
                      variant="destructive"
                      aria-label={t('auto.components.workbench.flow.stop', 'Stop')}
                      onClick={stop}
                    >
                      <Square className="size-3.5 fill-current" />
                    </NativeChatComposerPrimaryButton>
                  ) : (
                    <NativeChatComposerPrimaryButton
                      disabled={!requirement.trim()}
                      aria-label={t('auto.components.workbench.flow.start', 'Start Workflow')}
                      onClick={submitRequirement}
                    >
                      <ArrowUp className="size-4" />
                    </NativeChatComposerPrimaryButton>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
