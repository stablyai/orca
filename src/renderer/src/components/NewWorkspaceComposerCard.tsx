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
import { SetProjectLocationDialog } from '@/components/new-workspace/SetProjectLocationDialog'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
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
import {
  EMPTY_EPHEMERAL_VM_RECIPES,
  EMPTY_PROJECT_HOST_SETUP_OPTIONS,
  EMPTY_PROJECT_OPTIONS,
  type NeedsProjectHostOption,
  type NewWorkspaceComposerCardProps
} from './new-workspace/new-workspace-composer-card-props'
import { getSshStatusLabel } from './new-workspace/new-workspace-composer-ssh-status'
import { useComposerFileDragOver } from './new-workspace/use-composer-file-drag-over'

export default function NewWorkspaceComposerCard(
  props: NewWorkspaceComposerCardProps
): React.JSX.Element {
  useTranslation()
  const {
    contextualTourSource,
    containerClassName,
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
  const openModal = useAppStore((state) => state.openModal)
  const activeModal = useAppStore((state) => state.activeModal)
  const defaultTuiAgent = useAppStore((state) => state.settings?.defaultTuiAgent ?? null)
  const disabledTuiAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  const projects = useAppStore((state) => state.projects)
  const repos = useAppStore((state) => state.repos)
  const nameInputFocusFrameRef = React.useRef<number | null>(null)
  const branchNameInputId = React.useId()
  const projectDescriptionId = React.useId()
  const [addRemoteHostMode, setAddRemoteHostMode] = React.useState<AddRemoteHostMode | null>(null)
  const [setLocationOption, setSetLocationOption] = React.useState<NeedsProjectHostOption | null>(
    null
  )

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
  const shouldShowRunTargetPicker =
    readyProjectHostSetupOptions.length > 0 ||
    ephemeralVmRecipes.length > 0 ||
    needsSetupProjectHostSetupOptions.length > 0
  const sshStatusLabel = selectedRepoSshStatus
    ? getSshStatusLabel(selectedRepoSshStatus)
    : translate('auto.components.NewWorkspaceComposerCard.notConnected', 'Not connected')
  const connectButtonLabel =
    selectedRepoSshStatus === 'disconnected' || selectedRepoSshStatus === null
      ? 'Connect'
      : 'Reconnect'
  const setupConfigLabel =
    setupConfig?.kind === 'default-tabs'
      ? 'Default tab commands'
      : setupConfig?.kind === 'setup-and-default-tabs'
        ? 'Setup and default tab commands'
        : 'Setup script'
  const setupRunLabel =
    setupConfig?.kind === 'default-tabs'
      ? 'Run default tab commands'
      : setupConfig?.kind === 'setup-and-default-tabs'
        ? 'Run setup and default tab commands'
        : 'Run setup command'
  const setupAskLabel =
    setupConfig?.kind === 'default-tabs'
      ? 'Run default tab commands now?'
      : setupConfig?.kind === 'setup-and-default-tabs'
        ? 'Run setup and default tab commands now?'
        : 'Run setup now?'
  const setupRunButtonLabel = setupConfig?.kind === 'setup' ? 'Run setup now' : 'Run commands now'
  const setupSkipButtonLabel = setupConfig?.kind === 'setup' ? 'Skip for now' : 'Skip commands'
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
      if (composerRef) {
        composerRef.current = node
      }
      onComposerNodeChange?.(node)
    },
    [cancelNameInputFocusFrame, composerRef, onComposerNodeChange]
  )
  const focusNameInput = React.useCallback((): void => {
    cancelNameInputFocusFrame()
    nameInputFocusFrameRef.current = requestAnimationFrame(() => {
      nameInputFocusFrameRef.current = null
      nameInputRef?.current?.focus()
    })
  }, [cancelNameInputFocusFrame, nameInputRef])
  const handleAddProject = React.useCallback((): void => {
    if (onAddProjectOverride) {
      onAddProjectOverride()
      return
    }
    openModal('add-repo')
  }, [onAddProjectOverride, openModal])
  const handleSetLocation = React.useCallback(
    (option: NeedsProjectHostOption): void => {
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
        const runtimeStatus = unwrapRuntimeRpcResult<RuntimeStatus>(response)
        useAppStore.getState().setRuntimeEnvironmentStatus(action.environmentId, {
          status: runtimeStatus,
          checkedAt: Date.now()
        })
      } catch (error) {
        if (action.kind === 'runtime') {
          useAppStore.getState().setRuntimeEnvironmentStatus(action.environmentId, {
            status: null,
            checkedAt: Date.now()
          })
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
      void updateSettings({ defaultTuiAgent: next })
    },
    [updateSettings]
  )
  const handleNamePlainEnter = React.useCallback((): void => {
    const agentTrigger = composerRef?.current?.querySelector<HTMLElement>(
      '[data-agent-combobox-root="true"][role="combobox"]'
    )
    agentTrigger?.focus()
  }, [composerRef])

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
      data-native-file-drop-target="composer"
      onDragEnter={dragHandlers.onDragEnter}
      onDragLeave={dragHandlers.onDragLeave}
      className={cn(
        'grid min-w-0 gap-1 rounded-md transition',
        isFileDragOver && 'ring-2 ring-ring/30',
        containerClassName
      )}
    >
      <div className="min-w-0 space-y-4 pt-3">
        <NewWorkspaceComposerProjectSection
          {...props}
          projectOptions={projectOptions}
          projectHostSetupOptions={projectHostSetupOptions}
          ephemeralVmRecipes={ephemeralVmRecipes}
          projectDescriptionId={projectDescriptionId}
          onAddProject={handleAddProject}
          focusNameInput={focusNameInput}
          shouldShowRunTargetPicker={shouldShowRunTargetPicker}
          handleProjectHostSetupChange={(setupId) => onProjectHostSetupChange?.(setupId)}
          handleAddSshHost={() => setAddRemoteHostMode('ssh')}
          handleAddRemoteServer={() => setAddRemoteHostMode('server')}
          handleConnectRunTargetHost={handleConnectRunTargetHost}
          handleSetLocation={handleSetLocation}
          sshStatusLabel={sshStatusLabel}
          connectButtonLabel={connectButtonLabel}
          selectedProjectName={selectedProjectName}
        />
        <NewWorkspaceComposerNameSection {...props} onNamePlainEnter={handleNamePlainEnter} />
        <NewWorkspaceComposerAgentSection
          {...props}
          visibleQuickAgents={visibleQuickAgents}
          defaultTuiAgent={defaultTuiAgent}
          handleSetDefaultAgent={handleSetDefaultAgent}
        />
        <NewWorkspaceComposerAdvancedSection
          {...props}
          branchNameInputId={branchNameInputId}
          setupConfigLabel={setupConfigLabel}
          setupRunLabel={setupRunLabel}
          setupAskLabel={setupAskLabel}
          setupRunButtonLabel={setupRunButtonLabel}
          setupSkipButtonLabel={setupSkipButtonLabel}
          showSetupAgentStartupPolicy={showSetupAgentStartupPolicy}
          parentWorktreeId={parentWorktreeId}
          onParentWorktreeIdChange={onParentWorktreeIdChange}
          selectedRepoExecutionHostId={selectedRepoExecutionHostId}
          selectedRepoProjectId={selectedRepoProjectId}
          activeFolderWorkspaceId={activeFolderWorkspaceId}
        />
      </div>
      <NewWorkspaceComposerFooter
        {...props}
        submitShortcutModifierLabel={getScreenSubmitModifierLabel()}
      />
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
      <SetProjectLocationDialog
        option={setLocationOption}
        projectName={selectedProjectName}
        projectKind={selectedRepoIsGit ? 'git' : 'folder'}
        defaultCloneUrl={defaultCloneUrl}
        onClose={handleSetLocationClose}
        onReady={handleSetLocationReady}
      />
    </div>
  )
}
