import { agentChoicePending } from '@/lib/host-chat-program'
import { toast } from 'sonner'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import AgentSettingsDialog from '@/components/agent/AgentSettingsDialog'
import { useComposerAddProjectController } from '@/components/new-workspace/use-composer-add-project-controller'
import type { ComposerModalData } from '@/components/new-workspace/new-workspace-composer-modal-data'
import { useComposerState } from '@/hooks/useComposerState'
import {
  composerLaunchWorkspace,
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from '@/lib/quick-workspace-agent-selection'
import { useAgentsOfferedForLaunch } from '@/lib/host-chat-program-acquisition'
import { shouldAllowComposerEnterSubmitTarget } from '@/lib/new-workspace-enter-guard'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace-composer-initial-focus'
import { getFolderWorkspacePrimaryActionLabel } from '@/components/sidebar/folder-workspace-composer-helpers'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import {
  selectCanonicalProjects,
  selectCanonicalProjectHostSetups
} from '@/store/project-host-setup-selector'
import {
  folderGroupDefaultTarget,
  projectWorkspaceDefault
} from '@/lib/quick-workspace-project-default'
import { resolveDesktopWorkspaceDefaultAgent } from '@/lib/desktop-workspace-default-agent'
import { useWorkspaceDefaultAgent } from '@/hooks/use-workspace-default-agent'

// Keep Add Project’s clone/SSH machinery outside the composer entry render, matching App loading.
const HostedAddRepoDialog = lazyWithRetry(() => import('@/components/sidebar/AddRepoDialog'), {
  reloadKey: 'composer-add-repo'
})

export default function NewWorkspaceComposerModal(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'new-workspace-composer')
  const modalData = useAppStore((s) => s.modalData as ComposerModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)

  if (!visible) {
    return null
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
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialGitHubWorkItem: modalData.initialGitHubWorkItem ?? null,
    initialTaskSourceContext: modalData.taskSourceContext ?? null,
    initialWorkspaceTarget: modalData.initialWorkspaceTarget ?? null,
    initialRepoId: modalData.initialRepoId,
    initialEphemeralVmRecipeId: modalData.initialEphemeralVmRecipeId,
    initialProjectGroupId: modalData.initialProjectGroupId,
    initialWorkspaceStatus: modalData.initialWorkspaceStatus,
    ...(modalData.initialBaseBranch ? { initialBaseBranch: modalData.initialBaseBranch } : {}),
    persistDraft: false,
    onCreated: onClose,
    isSubmissionCancelled,
    ...(modalData.telemetrySource ? { telemetrySource: modalData.telemetrySource } : {}),
    enableIssueAutomation: modalData.enableIssueAutomation === true
  })
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  // User picks outrank newly detected preferences. Derive from an override so detection stays current without an effect-driven extra commit.
  const [quickAgentOverride, setQuickAgentOverride] = useState<TuiAgent | null | undefined>(
    undefined
  )
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
  const launchWorkspace =
    cardProps.agentRows?.target.workspace ?? composerLaunchWorkspace(cardProps)
  const offeredAgentIds = useAgentsOfferedForLaunch(launchWorkspace, cardProps.detectedAgentIds)
  const detected = cardProps.detectedAgentIds ? [...cardProps.detectedAgentIds] : null
  const choicePending = (agent: TuiAgent): boolean =>
    agentChoicePending(useAppStore.getState(), agent, launchWorkspace, detected)
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
  const [quickSelectionCleared, setQuickSelectionCleared] = useState(false)
  const quickSetupOnly = quickAgent === null && quickSelectionCleared

  // Why keyed by agent: a pick repaired to another agent must not carry the old one's surface.
  const [quickAgentPick, setQuickAgentPick] = useState<{
    agent: TuiAgent | null
    surface?: AgentLaunchSurface
  }>({ agent: null })
  const quickAgentSurface = quickAgentPick.agent === quickAgent ? quickAgentPick.surface : undefined
  const observation = useAgentMenuObservation(
    cardProps.agentRows?.target ?? null,
    active && Boolean(cardProps.agentRows),
    cardProps.agentRows?.detectionTarget,
    { wakeOnOpen: true }
  )
  const launchSelection = observation.selectionFor(quickAgent, quickAgentSurface)
  const createDisabled =
    formDisabled || creationInFlight || defaultPending || !launchSelection.ready

  const handleQuickAgentChange = useCallback(
    (agent: TuiAgent | null, surface?: AgentLaunchSurface) => {
      setQuickAgentOverride(agent)
      setQuickAgentPick({ agent, surface })
      setQuickSelectionCleared(false)
    },
    []
  )

  const handleQuickSetupOnlySelect = useCallback(() => {
    setQuickAgentOverride(null)
    setQuickSelectionCleared(true)
  }, [])

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
        setupOnly: quickSetupOnly,
        launchChoice: selection.choice
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
    cardProps.selectedRepoExecutionHostId,
    recordAgent,
    observation,
    launchSelection,
    quickSetupOnly,
    submitQuick
  ])
  const { addProjectOpen, addProjectMounted, openAddProject, addProjectController } =
    useComposerAddProjectController(selectAddedProjectRepo, selectAddedProjectGroup, nameInputRef)
  const [setLocationOpen, setSetLocationOpen] = useState(false)
  const primaryActionLabel = isFolderWorkspaceTarget
    ? getFolderWorkspacePrimaryActionLabel()
    : cardProps.selectedRepoIsGit
      ? translate('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
      : translate('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')

  // Let Radix own Escape for the topmost layer. This dialog auto-focuses input, so page-style blur-first handling swallowed its first Escape.
  const nestedDialogOpen = agentSettingsOpen || addProjectOpen || setLocationOpen
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
            ? translate(
                'auto.components.sidebar.FolderWorkspaceComposerDialog.title',
                'Create Folder Workspace'
              )
            : primaryActionLabel}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {translate(
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
        containerClassName="px-2"
        contentClassName="-mx-2 flex-1 overflow-y-auto px-2 pb-1 scrollbar-sleek"
        composerRef={composerRef}
        onComposerNodeChange={onComposerNodeChange}
        nameInputRef={nameInputRef}
        quickAgent={quickAgent}
        onQuickAgentChange={handleQuickAgentChange}
        quickSetupOnly={quickSetupOnly}
        onQuickSetupOnlySelect={handleQuickSetupOnlySelect}
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
        onOpenAgentSettings={() => setAgentSettingsOpen(true)}
        onCreate={() => void handleCreate()}
        onAddProjectOverride={openAddProject}
        onNestedDialogOpenChange={setSetLocationOpen}
      />
      <AgentSettingsDialog open={agentSettingsOpen} onOpenChange={setAgentSettingsOpen} />
      {addProjectMounted ? (
        <Suspense fallback={null}>
          <HostedAddRepoDialog hosted={addProjectController} />
        </Suspense>
      ) : null}
    </>
  )
}
