import type { ComposerModalData } from './composer-modal-data'
import { reportComposerPreparationFailure } from './composer-creation-recovery'
import { toast } from 'sonner'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { agentChoicePending } from '@/lib/agent-session/launch/inventory/host-chat-program'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import AgentSettingsDialog, {
  restoreAgentSettingsInvoker
} from '@/components/agent/AgentSettingsDialog'
import { useComposerHostedAddProject } from './use-composer-hosted-add-project'
import { useComposerState } from '@/hooks/useComposerState'
import {
  composerLaunchWorkspace,
  quickWorkspacePickerInputs,
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from '@/lib/workspace/creation/quick-workspace-agent-selection'
import { useAgentsOfferedForLaunch } from '@/lib/agent-session/launch/inventory/host-chat-program-acquisition'
import { shouldAllowComposerEnterSubmitTarget } from '@/lib/workspace/creation/new-workspace-enter-guard'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import '@/components/sidebar/workspace-creation/folder/folder-workspace-source-repos'
import { getFolderWorkspacePrimaryActionLabel } from '@/components/sidebar/workspace-creation/folder/folder-workspace-source-selection'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

// Keep Add Project’s clone/SSH machinery outside the composer entry render, matching App loading.
const HostedAddRepoDialog = lazyWithRetry(
  () => import('@/components/sidebar/project-admission/dialog/AddRepoDialog'),
  {
    reloadKey: 'composer-add-repo'
  }
)

import {
  selectCanonicalProjects,
  selectCanonicalProjectHostSetups
} from '@/store/projects/project-host-setup-selector'
import {
  folderGroupDefaultTarget,
  projectWorkspaceDefault
} from '@/lib/quick-workspace-project-default'
import { resolveDesktopWorkspaceDefaultAgent } from '@/lib/desktop-workspace-default-agent'
import { useWorkspaceDefaultAgent } from '@/hooks/use-workspace-default-agent'

export default function NewWorkspaceComposerQuickTab({
  modalData,
  onClose,
  isSubmissionCancelled
}: {
  modalData: ComposerModalData
  onClose: () => void
  isSubmissionCancelled: () => boolean
}): React.JSX.Element {
  const t = useTranslate()
  const settings = useAppStore((s) => s.settings)
  const projects = useAppStore(selectCanonicalProjects)
  const projectHostSetups = useAppStore(selectCanonicalProjectHostSetups)
  const {
    cardProps,
    composerRef,
    onComposerNodeChange,
    nameInputRef,
    submitQuick,
    createDisabled: formDisabled,
    selectAddedProjectRepo,
    selectAddedProjectGroup
  } = useComposerState({
    initialName: modalData.prefilledName ?? '',
    // Quick create ignores legacy prompt-prefill payloads.
    initialPrompt: '',
    initialNote: modalData.recovery?.note,
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialGitHubWorkItem: modalData.initialGitHubWorkItem ?? null,
    initialTaskSourceContext: modalData.taskSourceContext ?? null,
    initialWorkspaceTarget: modalData.initialWorkspaceTarget ?? null,
    initialRepoId: modalData.initialRepoId,
    initialEphemeralVmRecipeId: modalData.initialEphemeralVmRecipeId,
    initialProjectGroupId: modalData.initialProjectGroupId,
    initialWorkspaceStatus: modalData.initialWorkspaceStatus,
    initialParentWorktreeId: modalData.initialParentWorktreeId,
    ...(modalData.initialBaseBranch ? { initialBaseBranch: modalData.initialBaseBranch } : {}),
    persistDraft: false,
    onCreated: onClose,
    isSubmissionCancelled,
    ...(modalData.telemetrySource ? { telemetrySource: modalData.telemetrySource } : {}),
    enableIssueAutomation: modalData.enableIssueAutomation === true
  })
  // Layer agent settings over the composer so edits retain the typed workspace/repo selection.
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const agentSettingsInvoker = useRef<HTMLButtonElement | null>(null)
  // User picks outrank newly detected preferences. Derive from an override so detection stays current without an effect-driven extra commit.
  const [quickAgentOverride, setQuickAgentOverride] = useState(modalData.recovery?.agent)
  const creationInFlightRef = useRef(false)
  const [creationInFlight, setCreationInFlight] = useState(false)
  const selectedProjectOption = cardProps.projectOptions.find(
    (option) => option.id === cardProps.selectedProjectId
  )
  const isFolderWorkspaceTarget = selectedProjectOption?.kind === 'project-group'
  const folderDefaultTarget = isFolderWorkspaceTarget
    ? folderGroupDefaultTarget(
        (cardProps.repoBackedSearchRepos ?? []).map((repo) => repo.id),
        projects,
        projectHostSetups,
        cardProps.selectedRepoExecutionHostId
      )
    : null
  const defaultTargetRepoId = isFolderWorkspaceTarget
    ? folderDefaultTarget?.repoId
    : cardProps.repoId
  const { hostDefaultAgent, defaultError, recordAgent, defaultPending } = useWorkspaceDefaultAgent(
    defaultTargetRepoId,
    cardProps.selectedRepoExecutionHostId,
    quickAgentOverride === undefined
  )
  // The picker rows' workspace when known, so the offered list and the rows read one host.
  const launchWorkspace =
    cardProps.agentRows?.target.workspace ?? composerLaunchWorkspace(cardProps)
  const offeredAgentIds = useAgentsOfferedForLaunch(launchWorkspace, cardProps.detectedAgentIds)
  const detected = cardProps.detectedAgentIds ? [...cardProps.detectedAgentIds] : null
  const choicePending = (agent: TuiAgent): boolean =>
    agentChoicePending(useAppStore.getState(), agent, launchWorkspace, detected)
  // Pending discovery preserves the existing catalog fallback; current facts settle the default.
  const configuredDefault =
    hostDefaultAgent ??
    projectWorkspaceDefault(
      projects,
      folderDefaultTarget?.projectId ?? cardProps.selectedRepoProjectId,
      settings?.defaultTuiAgent
    )
  const preferredQuickAgent =
    configuredDefault && configuredDefault !== 'blank'
      ? configuredDefault
      : pickQuickWorkspaceAgent(
          configuredDefault,
          cardProps.detectedAgentIds,
          settings?.disabledTuiAgents,
          offeredAgentIds,
          choicePending
        )
  // An explicit pick stays valid where it opens as a chat without its CLI.
  const resolvedQuickAgentSelection = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride,
    preferredQuickAgent,
    detectedAgentIds: cardProps.detectedAgentIds,
    offeredAgentIds,
    selectedChoiceUnresolved: Boolean(quickAgentOverride && choicePending(quickAgentOverride)),
    disabledTuiAgents: settings?.disabledTuiAgents
  })
  if (resolvedQuickAgentSelection.quickAgentOverride !== quickAgentOverride) {
    // Repair invalid picks before children render an unavailable option.
    setQuickAgentOverride(resolvedQuickAgentSelection.quickAgentOverride)
  }
  const quickAgent = resolvedQuickAgentSelection.quickAgent
  const chipAgentIds =
    offeredAgentIds &&
    new Set([...offeredAgentIds, ...(quickAgent && choicePending(quickAgent) ? [quickAgent] : [])])
  // Why keyed by agent: a pick repaired to another agent must not carry the old one's surface.
  const [quickAgentPick, setQuickAgentPick] = useState<
    Omit<NonNullable<ComposerModalData['recovery']>, 'note'>
  >(modalData.recovery ?? { agent: null })
  const observation = useAgentMenuObservation(
    cardProps.agentRows?.target ?? null,
    Boolean(cardProps.agentRows),
    cardProps.agentRows?.detectionTarget,
    { wakeOnOpen: true }
  )
  const pickerDraft =
    quickAgentPick.agent === quickAgent && quickAgentPick.contextKey === observation.contextKey
      ? quickAgentPick.draft
      : undefined
  const quickAgentSurface = quickAgentPick.agent === quickAgent ? quickAgentPick.surface : undefined
  const launchSelection = observation.selectionFor(quickAgent, quickAgentSurface)
  const createDisabled =
    formDisabled || creationInFlight || defaultPending || !launchSelection.ready

  const handleQuickAgentChange = useCallback(
    (
      agent: TuiAgent | null,
      surface?: AgentLaunchSurface,
      draft?: AgentPickerDraft,
      entry?: AgentPickerEntry
    ) => {
      setQuickAgentOverride(agent)
      setQuickAgentPick({ agent, surface, draft, entry, contextKey: observation.contextKey })
    },
    [observation.contextKey]
  )

  const handleCreate = useCallback(async (): Promise<void> => {
    if (createDisabled || creationInFlightRef.current) {
      return
    }
    creationInFlightRef.current = true
    setCreationInFlight(true)
    try {
      if (
        quickAgentOverride === undefined &&
        quickAgent &&
        isFolderWorkspaceTarget &&
        !folderDefaultTarget
      ) {
        toast.error(
          translate(
            'auto.components.NewWorkspaceComposerModal.folderDefaultAmbiguous',
            'This folder workspace has no single target project. Choose an explicit agent.'
          )
        )
        return
      }
      let agent = quickAgent
      let selection = launchSelection
      if (quickAgentOverride === undefined && defaultTargetRepoId) {
        try {
          const resolved = await resolveDesktopWorkspaceDefaultAgent({
            repo: defaultTargetRepoId,
            hostId: cardProps.selectedRepoExecutionHostId
          })
          agent = resolved.agent
          recordAgent(agent)
          if (agent !== quickAgent) {
            selection = observation.selectionFor(agent, undefined)
            if (!selection.ready) {
              toast.error(
                translate(
                  'auto.components.NewWorkspaceComposerModal.targetDefaultChanged',
                  'The target project default changed. Check its agent and retry.'
                )
              )
              return
            }
          }
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error))
          return
        }
      }
      await submitQuick(agent, {
        setupOnly: agent === null,
        launchChoice: selection.choice,
        onLegacyPreparationFailure: (error) =>
          reportComposerPreparationFailure({
            error,
            modalData,
            cardProps,
            recovery: { ...quickAgentPick, agent, note: cardProps.note },
            isSubmissionCancelled
          }),
        ...quickWorkspacePickerInputs(
          pickerDraft,
          quickAgentPick.entry,
          selection.choice?.executionHostId
        )
      })
    } finally {
      creationInFlightRef.current = false
      setCreationInFlight(false)
    }
  }, [
    createDisabled,
    quickAgent,
    quickAgentOverride,
    defaultTargetRepoId,
    isFolderWorkspaceTarget,
    folderDefaultTarget,
    cardProps,
    recordAgent,
    observation,
    launchSelection,
    pickerDraft,
    quickAgentPick,
    submitQuick,
    isSubmissionCancelled,
    modalData
  ])
  const {
    addProjectOpen,
    addProjectMounted,
    nestedDialogCount,
    addProjectController,
    handleNestedDialogOpenChange,
    handleOpenAddProject,
    handleOpenAddProjectEntryRequest
  } = useComposerHostedAddProject({
    nameInputRef,
    selectAddedProjectRepo,
    selectAddedProjectGroup
  })
  const primaryActionLabel = isFolderWorkspaceTarget
    ? getFolderWorkspacePrimaryActionLabel(t)
    : cardProps.selectedRepoIsGit
      ? t('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
      : t('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')

  // Let Radix own Escape for the topmost layer. This dialog auto-focuses input, so page-style blur-first handling swallowed its first Escape.
  const nestedDialogOpen = agentSettingsOpen || addProjectOpen || nestedDialogCount > 0
  useEffect(() => {
    if (nestedDialogOpen) {
      // Nested dialogs own input; never submit the underlying composer through this capture handler.
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Creation uses the screen submit chord, outside configurable app commands.
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (!shouldAllowComposerEnterSubmitTarget(target, composerRef.current)) {
        return
      }
      if (createDisabled || composerRef.current?.hasAttribute('data-sparse-preset-editing')) {
        return
      }
      event.preventDefault()
      void handleCreate()
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [composerRef, createDisabled, handleCreate, nestedDialogOpen])

  return (
    <>
      <DialogHeader className="gap-1">
        <DialogTitle className="text-base font-semibold">
          {isFolderWorkspaceTarget
            ? t(
                'auto.components.sidebar.FolderWorkspaceComposerDialog.title',
                'Create Folder Workspace'
              )
            : primaryActionLabel}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t(
            'components.newWorkspace.createDescription',
            'Choose the project and workspace name. Select an agent if you want to start one.'
          )}
        </DialogDescription>
      </DialogHeader>
      {quickAgentOverride === undefined && defaultPending ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {translate(
            'auto.components.NewWorkspaceComposerModal.resolvingTargetDefault',
            'Resolving target project default…'
          )}
        </p>
      ) : quickAgentOverride === undefined && defaultError ? (
        <p role="alert" className="text-xs text-destructive">
          {defaultError}
        </p>
      ) : null}
      <NewWorkspaceComposerCard
        contextualTourSource={modalData.contextualTourSource}
        // Keep focus rings and the Advanced hover highlight inside the scroll padding.
        containerClassName="px-2"
        contentClassName="-mx-2 flex-1 overflow-y-auto px-2 pb-1 scrollbar-sleek"
        composerRef={composerRef}
        onComposerNodeChange={onComposerNodeChange}
        nameInputRef={nameInputRef}
        quickAgent={quickAgent}
        agentPickerDraft={pickerDraft}
        agentSetupDisabled={
          observation.model.state !== 'settled' ||
          observation.model.pickerContext?.executionHostId !== 'local'
        }
        onQuickAgentChange={handleQuickAgentChange}
        {...cardProps}
        // Chips list offered agents, keeping a pick whose chat is still being learned.
        detectedAgentIds={chipAgentIds}
        createDisabled={createDisabled}
        agentSurfaceRows={
          cardProps.agentRows
            ? {
                model: observation.model,
                selection: launchSelection,
                surface: quickAgentSurface,
                contextKey: observation.contextKey,
                onPick: handleQuickAgentChange
              }
            : undefined
        }
        primaryActionLabel={primaryActionLabel}
        onOpenAgentSettings={(invoker) => {
          agentSettingsInvoker.current = invoker
          setAgentSettingsOpen(true)
        }}
        onCreate={() => void handleCreate()}
        onAddProjectOverride={handleOpenAddProject}
        onAddProjectEntryRequest={handleOpenAddProjectEntryRequest}
        onNestedDialogOpenChange={handleNestedDialogOpenChange}
      />
      <AgentSettingsDialog
        open={agentSettingsOpen}
        onOpenChange={setAgentSettingsOpen}
        onCloseAutoFocus={(event) => {
          const invoker = agentSettingsInvoker.current
          agentSettingsInvoker.current = null
          restoreAgentSettingsInvoker(event, invoker)
        }}
      />
      {addProjectMounted ? (
        <Suspense fallback={null}>
          <HostedAddRepoDialog hosted={addProjectController} />
        </Suspense>
      ) : null}
    </>
  )
}
