import React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import { resolveProjectCloneUrlPrefill } from '@/lib/project-clone-url-prefill'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '@/components/sidebar/AddRemoteHostDialog'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import type * as SetProjectLocationDialogModule from '@/components/new-workspace/SetProjectLocationDialog'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { withUiConnectTimeout } from '@/ssh/ssh-connect-ui-timeout'
import { isSshConnectInFlight, trackSshConnect } from '@/ssh/ssh-connect-in-flight'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../shared/tui-agent-selection'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { NewWorkspaceComposerAdvancedSection } from './new-workspace/NewWorkspaceComposerAdvancedSection'
import { NewWorkspaceComposerAgentSection } from './new-workspace/NewWorkspaceComposerAgentSection'
import { NewWorkspaceComposerFooter } from './new-workspace/NewWorkspaceComposerFooter'
import { NewWorkspaceComposerNameSection } from './new-workspace/NewWorkspaceComposerNameSection'
import { NewWorkspaceComposerProjectSection } from './new-workspace/NewWorkspaceComposerProjectSection'
import { NewWorkspaceComposerPromptSection } from './new-workspace/NewWorkspaceComposerPromptSection'
import { NewWorkspaceComposerPromptToolbar } from './new-workspace/NewWorkspaceComposerPromptToolbar'
import { NewWorkspaceComposerTargetNotices } from './new-workspace/NewWorkspaceComposerTargetNotices'
import {
  EMPTY_EPHEMERAL_VM_RECIPES,
  EMPTY_PROJECT_HOST_SETUP_OPTIONS,
  EMPTY_PROJECT_OPTIONS,
  type NeedsProjectHostOption,
  type NewWorkspaceComposerCardProps
} from './new-workspace/new-workspace-composer-card-props'
import { getSshStatusLabel } from './new-workspace/new-workspace-composer-ssh-status'
import { getSetupDecisionLabels } from './new-workspace/setup-decision-labels'
import { useNewWorkspaceComposerFileDrop } from './new-workspace/use-new-workspace-composer-file-drop'
import { useComposerFileDragOver } from './new-workspace/use-composer-file-drag-over'
import { buildDefaultAgentSettingsUpdate } from '../../../shared/default-agent-settings'

// Lazy-load the project-location browser outside boot; warming shares this module entry with the click.
const loadSetProjectLocationDialog = (): Promise<typeof SetProjectLocationDialogModule> =>
  import('@/components/new-workspace/SetProjectLocationDialog')

const SetProjectLocationDialog = lazyWithRetry(
  () =>
    loadSetProjectLocationDialog().then((module) => ({
      default: module.SetProjectLocationDialog
    })),
  { reloadKey: 'set-project-location-dialog' }
)

export default function NewWorkspaceComposerCard(
  props: NewWorkspaceComposerCardProps
): React.JSX.Element {
  useTranslation()
  const {
    contextualTourSource,
    containerClassName,
    contentClassName,
    composerRef,
    onComposerNodeChange,
    nameInputRef,
    eligibleRepos,
    repoId,
    selectedRepoIsGit,
    onProjectHostSetupChange,
    selectedRepoSshStatus,
    setupConfig,
    setupControlsEnabled = true,
    selectedProjectId = null,
    parentWorktreeId,
    onParentWorktreeIdChange,
    selectedRepoExecutionHostId,
    selectedRepoProjectId,
    activeFolderWorkspaceId,
    onAddProjectOverride,
    onNestedDialogOpenChange
  } = props
  const projectOptions = props.projectOptions ?? EMPTY_PROJECT_OPTIONS
  const projectHostSetupOptions = props.projectHostSetupOptions ?? EMPTY_PROJECT_HOST_SETUP_OPTIONS
  const ephemeralVmRecipes = props.ephemeralVmRecipes ?? EMPTY_EPHEMERAL_VM_RECIPES
  const { isFileDragOver, dragHandlers } = useComposerFileDragOver()
  const attachDropOwner = useNewWorkspaceComposerFileDrop({
    projectPath: props.selectedRepoPath,
    hostId: selectedRepoExecutionHostId,
    connectionId: props.selectedRepoConnectionId,
    applyDrop: props.onNativeFileDrop
  })
  const openModal = useAppStore((state) => state.openModal)
  const activeModal = useAppStore((state) => state.activeModal)
  const defaultTuiAgent = useAppStore((state) => state.settings?.defaultTuiAgent ?? null)
  const promptFirst = useAppStore((state) => state.settings?.promptFirstComposer === true)
  const disabledTuiAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  const projects = useAppStore((state) => state.projects)
  const repos = useAppStore((state) => state.repos)
  const nameInputFocusFrameRef = React.useRef<number | null>(null)
  const branchNameInputId = React.useId()
  const projectDescriptionId = React.useId()
  const [sparseEditing, setSparseEditing] = React.useState(false)
  const [addRemoteHostMode, setAddRemoteHostMode] = React.useState<AddRemoteHostMode | null>(null)
  const [setLocationOption, setSetLocationOption] = React.useState<NeedsProjectHostOption | null>(
    null
  )
  // Retain the dialog while its cleared option drives the close animation.
  const [setLocationDialogMounted, setSetLocationDialogMounted] = React.useState(false)

  const selectedRepo = eligibleRepos.find((candidate) => candidate.id === repoId)
  const selectedRepoName = selectedRepo?.displayName ?? selectedRepo?.path ?? 'This project'
  const selectedProjectName =
    projectOptions.find((candidate) => candidate.id === selectedProjectId)?.displayName ??
    selectedRepoName
  const defaultCloneUrl = resolveProjectCloneUrlPrefill(projects, repos, selectedProjectId)
  const readyProjectHostSetupOptions = projectHostSetupOptions.filter(
    (option) => option.kind === 'ready'
  )
  const needsSetupProjectHostSetupOptions = projectHostSetupOptions.filter(
    (option) => option.kind === 'needs-setup'
  )
  // Warm when a usable Set location row appears so reading the picker overlaps the chunk load.
  const hasSetLocationOption = needsSetupProjectHostSetupOptions.some(
    (option) => option.canSetLocation
  )
  React.useEffect(() => {
    if (hasSetLocationOption) {
      void loadSetProjectLocationDialog().catch(() => {})
    }
  }, [hasSetLocationOption])
  const shouldShowRunTargetPicker =
    readyProjectHostSetupOptions.length > 0 ||
    ephemeralVmRecipes.length > 0 ||
    needsSetupProjectHostSetupOptions.length > 0
  const sshStatusLabel = selectedRepoSshStatus
    ? getSshStatusLabel(selectedRepoSshStatus)
    : translate('auto.components.NewWorkspaceComposerCard.notConnected', 'Not connected')
  const connectButtonLabel =
    selectedRepoSshStatus === 'disconnected' || selectedRepoSshStatus === null
      ? translate('auto.components.NewWorkspaceComposerCard.connect', 'Connect')
      : translate('auto.components.NewWorkspaceComposerCard.reconnect', 'Reconnect')
  const setupDecisionLabels = getSetupDecisionLabels(setupConfig)
  const showSetupAgentStartupPolicy =
    setupControlsEnabled && setupConfig !== null && setupConfig.kind !== 'default-tabs'
  const agentCatalog = getAgentCatalog()
  const enabledAgentIds = new Set(
    filterEnabledTuiAgents(
      agentCatalog.map((candidate) => candidate.id),
      disabledTuiAgents
    )
  )
  const visibleQuickAgents = agentCatalog.filter((agent) => {
    return (
      enabledAgentIds.has(agent.id) &&
      (props.detectedAgentIds === null || props.detectedAgentIds.has(agent.id))
    )
  })

  const cancelNameInputFocusFrame = React.useCallback((): void => {
    if (nameInputFocusFrameRef.current !== null) {
      cancelAnimationFrame(nameInputFocusFrameRef.current)
      nameInputFocusFrameRef.current = null
    }
  }, [])
  const setComposerNode = React.useCallback(
    (node: HTMLDivElement | null): void => {
      if (!node) {
        cancelNameInputFocusFrame()
      }
      attachDropOwner(node)
      if (composerRef) {
        composerRef.current = node
      }
      onComposerNodeChange?.(node)
    },
    [attachDropOwner, cancelNameInputFocusFrame, composerRef, onComposerNodeChange]
  )
  // Why: picking a project hands focus to whatever gets typed next: the prompt
  // in the prompt-first layout, the name/source field in the classic one.
  const focusNextInput = React.useCallback((): void => {
    cancelNameInputFocusFrame()
    nameInputFocusFrameRef.current = requestAnimationFrame(() => {
      nameInputFocusFrameRef.current = null
      if (promptFirst) {
        composerRef?.current
          ?.querySelector<HTMLElement>('[data-workspace-prompt-input="true"]')
          ?.focus()
        return
      }
      nameInputRef?.current?.focus()
    })
  }, [cancelNameInputFocusFrame, composerRef, nameInputRef, promptFirst])
  const handleAddProject = React.useCallback((): void => {
    if (onAddProjectOverride) {
      onAddProjectOverride()
      return
    }
    openModal('add-repo')
  }, [onAddProjectOverride, openModal])
  const handleSetLocation = React.useCallback(
    (option: NeedsProjectHostOption): void => {
      setSetLocationDialogMounted(true)
      setSetLocationOption(option)
      onNestedDialogOpenChange?.(true)
    },
    [onNestedDialogOpenChange]
  )
  const handleSetLocationClose = React.useCallback((): void => {
    setSetLocationOption(null)
    onNestedDialogOpenChange?.(false)
  }, [onNestedDialogOpenChange])
  const handleSetLocationReady = React.useCallback(
    (setupId: string): void => {
      handleSetLocationClose()
      onProjectHostSetupChange?.(setupId)
    },
    [handleSetLocationClose, onProjectHostSetupChange]
  )
  const handleConnectRunTargetHost = React.useCallback(
    async (option: NeedsProjectHostOption): Promise<void> => {
      const action = option.connectAction
      if (!action) {
        return
      }
      try {
        if (action.kind === 'ssh') {
          if (isSshConnectInFlight(action.targetId)) {
            return
          }
          await withUiConnectTimeout(
            trackSshConnect(action.targetId, window.api.ssh.connect({ targetId: action.targetId }))
          )
          return
        }
        const response = await window.api.runtimeEnvironments.getStatus({
          selector: action.environmentId,
          timeoutMs: 15_000
        })
        unwrapRuntimeRpcResult<RuntimeStatus>(response)
        await useAppStore.getState().readRuntimeHostStatusSnapshots()
      } catch (error) {
        if (action.kind === 'runtime') {
          await useAppStore.getState().readRuntimeHostStatusSnapshots()
        }
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.NewWorkspaceComposerCard.hostConnectionFailed',
                'Connection failed'
              )
        )
      }
    },
    []
  )
  const handleSetDefaultAgent = React.useCallback(
    (next: TuiAgent | 'blank' | null): void => {
      void updateSettings(buildDefaultAgentSettingsUpdate(next))
    },
    [updateSettings]
  )
  const handleNamePlainEnter = React.useCallback((): void => {
    const agentTrigger = composerRef?.current?.querySelector<HTMLElement>(
      '[data-agent-combobox-root="true"][role="combobox"]'
    )
    agentTrigger?.focus()
  }, [composerRef])

  const targetPickerProps = {
    projectOptions,
    projectHostSetupOptions,
    ephemeralVmRecipes,
    projectDescriptionId,
    onAddProject: handleAddProject,
    shouldShowRunTargetPicker,
    handleProjectHostSetupChange: (setupId: string) => onProjectHostSetupChange?.(setupId),
    handleAddSshHost: () => setAddRemoteHostMode('ssh'),
    handleAddRemoteServer: () => setAddRemoteHostMode('server'),
    handleConnectRunTargetHost,
    handleSetLocation
  }
  const agentPickerProps = {
    visibleQuickAgents,
    defaultTuiAgent,
    handleSetDefaultAgent
  }
  useContextualTour(
    'workspace-creation',
    projectOptions.length > 0 && Boolean(selectedProjectId),
    contextualTourSource ??
      (activeModal === 'new-workspace-composer'
        ? 'workspace_creation_modal'
        : 'workspace_creation_visible')
  )

  return (
    <div
      ref={setComposerNode}
      data-workspace-composer-root="true"
      data-sparse-preset-editing={sparseEditing ? 'true' : undefined}
      onDragEnter={dragHandlers.onDragEnter}
      onDragLeave={dragHandlers.onDragLeave}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col gap-1 rounded-md transition',
        isFileDragOver &&
          props.selectedRepoPath &&
          selectedRepoExecutionHostId &&
          props.onNativeFileDrop &&
          'ring-2 ring-ring/30',
        containerClassName
      )}
    >
      <div className={cn('min-h-0 min-w-0 space-y-4 pt-3', contentClassName)}>
        {promptFirst ? (
          <>
            <NewWorkspaceComposerPromptSection
              {...props}
              createDisabled={props.createDisabled || sparseEditing}
              toolbar={
                <NewWorkspaceComposerPromptToolbar
                  {...props}
                  {...targetPickerProps}
                  {...agentPickerProps}
                  disabled={sparseEditing}
                  createDisabled={props.createDisabled || sparseEditing}
                  focusPromptInput={focusNextInput}
                  submitShortcutModifierLabel={getScreenSubmitModifierLabel()}
                />
              }
            />
            <NewWorkspaceComposerTargetNotices
              {...props}
              projectOptions={projectOptions}
              projectDescriptionId={projectDescriptionId}
              sshStatusLabel={sshStatusLabel}
              connectButtonLabel={connectButtonLabel}
              selectedProjectName={selectedProjectName}
            />
            <NewWorkspaceComposerNameSection {...props} onNamePlainEnter={handleNamePlainEnter} />
          </>
        ) : (
          <>
            <NewWorkspaceComposerProjectSection
              {...props}
              {...targetPickerProps}
              disabled={sparseEditing}
              focusNameInput={focusNextInput}
              sshStatusLabel={sshStatusLabel}
              connectButtonLabel={connectButtonLabel}
              selectedProjectName={selectedProjectName}
            />
            <NewWorkspaceComposerNameSection {...props} onNamePlainEnter={handleNamePlainEnter} />
            <NewWorkspaceComposerAgentSection
              {...props}
              {...agentPickerProps}
              createDisabled={props.createDisabled || sparseEditing}
              advancedLocked={sparseEditing}
            />
          </>
        )}
        <NewWorkspaceComposerAdvancedSection
          {...props}
          onSparseEditingChange={setSparseEditing}
          sparseEditing={sparseEditing}
          branchNameInputId={branchNameInputId}
          {...setupDecisionLabels}
          showSetupAgentStartupPolicy={showSetupAgentStartupPolicy}
          parentWorktreeId={parentWorktreeId}
          onParentWorktreeIdChange={onParentWorktreeIdChange}
          selectedRepoExecutionHostId={selectedRepoExecutionHostId}
          selectedRepoProjectId={selectedRepoProjectId}
          activeFolderWorkspaceId={activeFolderWorkspaceId}
        />
      </div>
      {!sparseEditing ? (
        <div className="shrink-0 space-y-1">
          <NewWorkspaceComposerFooter
            {...props}
            submitShortcutModifierLabel={getScreenSubmitModifierLabel()}
            hidePrimaryAction={promptFirst}
          />
        </div>
      ) : null}
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
      {setLocationDialogMounted ? (
        <React.Suspense fallback={null}>
          <SetProjectLocationDialog
            option={setLocationOption}
            projectName={selectedProjectName}
            projectKind={selectedRepoIsGit ? 'git' : 'folder'}
            defaultCloneUrl={defaultCloneUrl}
            onClose={handleSetLocationClose}
            onReady={handleSetLocationReady}
          />
        </React.Suspense>
      ) : null}
    </div>
  )
}
