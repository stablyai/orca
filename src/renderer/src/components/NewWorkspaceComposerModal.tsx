import type { ComposerModalData } from './new-workspace/composer-modal-data'
import { toast } from 'sonner'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../shared/agent-launch/picker/agent-launch-picker'
import { DirectWorkItemSetupDialog } from './new-workspace/DirectWorkItemSetupDialog'
import { agentChoicePending } from '@/lib/agent-session/launch/inventory/host-chat-program'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import AgentSettingsDialog, {
  restoreAgentSettingsInvoker
} from '@/components/agent/AgentSettingsDialog'
import { useComposerHostedAddProject } from './new-workspace/use-composer-hosted-add-project'
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
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace/creation/workspace-composer-initial-focus'
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

export default function NewWorkspaceComposerModal(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'new-workspace-composer')
  const modalData = useAppStore((s) => s.modalData as ComposerModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)

  if (!visible) {
    return null
  }

  if (modalData?.directSetup) {
    return (
      <DirectWorkItemSetupDialog key={modalData.directSetup.id} request={modalData.directSetup} />
    )
  }

  return <ComposerModalBody modalData={modalData ?? {}} onClose={closeModal} />
}

function ComposerModalBody({
  modalData,
  onClose
}: {
  modalData: ComposerModalData
  onClose: () => void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const submitCancelledRef = useRef(false)
  const handleDismiss = useCallback(() => {
    submitCancelledRef.current = true
    onClose()
  }, [onClose])
  const isSubmissionCancelled = useCallback(() => submitCancelledRef.current, [])

  return (
    <Dialog open onOpenChange={(open) => !open && handleDismiss()}>
      <DialogContent
        ref={dialogRef}
        className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (dialogRef.current?.querySelector('[data-sparse-preset-editor]')) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={(event) => {
          // Override Radix’s first-tabbable close button with the name/source field for immediate typing.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          getWorkspaceComposerInitialFocusTarget(content)?.focus({ preventScroll: true })
        }}
      >
        <QuickTabBody
          modalData={modalData}
          onClose={onClose}
          isSubmissionCancelled={isSubmissionCancelled}
          active
        />
      </DialogContent>
    </Dialog>
  )
}

function QuickTabBody({
  modalData,
  onClose,
  isSubmissionCancelled,
  active
}: {
  modalData: ComposerModalData
  onClose: () => void
  isSubmissionCancelled: () => boolean
  active: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const settings = useAppStore((s) => s.settings)
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
    initialPrompt: modalData.initialAgentPrompt ?? '',
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
  const [quickAgentOverride, setQuickAgentOverride] = useState<TuiAgent | null | undefined>(
    modalData.recovery?.agent
  )
  // The picker rows' workspace when known, so the offered list and the rows read one host.
  const launchWorkspace =
    cardProps.agentRows?.target.workspace ?? composerLaunchWorkspace(cardProps)
  const offeredAgentIds = useAgentsOfferedForLaunch(launchWorkspace, cardProps.detectedAgentIds)
  const detected = cardProps.detectedAgentIds ? [...cardProps.detectedAgentIds] : null
  const choicePending = (agent: TuiAgent): boolean =>
    agentChoicePending(useAppStore.getState(), agent, launchWorkspace, detected)
  // Pending discovery preserves the existing catalog fallback; current facts settle the default.
  const preferredQuickAgent = pickQuickWorkspaceAgent(
    settings?.defaultTuiAgent,
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
    active && Boolean(cardProps.agentRows),
    cardProps.agentRows?.detectionTarget,
    { wakeOnOpen: true }
  )
  const pickerDraft =
    quickAgentPick.agent === quickAgent && quickAgentPick.contextKey === observation.contextKey
      ? quickAgentPick.draft
      : undefined
  const quickAgentSurface = quickAgentPick.agent === quickAgent ? quickAgentPick.surface : undefined
  const launchSelection = observation.selectionFor(quickAgent, quickAgentSurface)
  const createDisabled = formDisabled || !launchSelection.ready

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
    if (createDisabled) {
      return
    }
    await submitQuick(quickAgent, {
      // Blank Terminal is the setup-only create: no agent, and no extra shell beside setup.
      setupOnly: quickAgent === null,
      initialPrompt: cardProps.agentPrompt,
      launchChoice: launchSelection.choice,
      onLegacyPreparationFailure: (error) => {
        if (isSubmissionCancelled()) {
          return
        }
        const snapshot = {
          ...modalData,
          prefilledName: cardProps.name,
          initialAgentPrompt: cardProps.agentPrompt,
          initialRepoId: cardProps.repoId,
          initialBaseBranch: cardProps.baseBranch,
          initialWorkspaceTarget:
            cardProps.selectedProjectId && cardProps.selectedRepoExecutionHostId
              ? {
                  projectId: cardProps.selectedProjectId,
                  hostId: cardProps.selectedRepoExecutionHostId,
                  projectHostSetupId: cardProps.selectedProjectHostSetupId ?? null
                }
              : modalData.initialWorkspaceTarget,
          linkedWorkItem: cardProps.linkedWorkItem,
          recovery: { ...quickAgentPick, agent: quickAgent, note: cardProps.note }
        }
        toast.error(getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error)), {
          action: {
            label: translate('auto.lib.composerCreateHandoff.reopen', 'Reopen'),
            onClick: () => {
              if (!isSubmissionCancelled() && useAppStore.getState().activeModal === 'none') {
                useAppStore.getState().openModal('new-workspace-composer', snapshot)
              }
            }
          }
        })
      },
      ...quickWorkspacePickerInputs(
        pickerDraft,
        quickAgentPick.entry,
        launchSelection.choice?.executionHostId
      )
    })
  }, [
    createDisabled,
    quickAgent,
    launchSelection.choice,
    submitQuick,
    pickerDraft,
    quickAgentPick,
    isSubmissionCancelled,
    modalData,
    cardProps
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
  const selectedProjectOption = cardProps.projectOptions.find(
    (option) => option.id === cardProps.selectedProjectId
  )
  const isFolderWorkspaceTarget = selectedProjectOption?.kind === 'project-group'
  const primaryActionLabel = isFolderWorkspaceTarget
    ? getFolderWorkspacePrimaryActionLabel(t)
    : cardProps.selectedRepoIsGit
      ? t('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
      : t('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')

  // Let Radix own Escape for the topmost layer. This dialog auto-focuses input, so page-style blur-first handling swallowed its first Escape.
  const nestedDialogOpen = agentSettingsOpen || addProjectOpen || nestedDialogCount > 0
  useEffect(() => {
    if (!active || nestedDialogOpen) {
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
  }, [active, composerRef, createDisabled, handleCreate, nestedDialogOpen])

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
