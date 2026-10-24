import { agentChoicePending } from '@/lib/host-chat-program'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { AddRepoDialogHostedController } from '@/components/sidebar/use-add-repo-hosted-controller'
import { useComposerState } from '@/hooks/useComposerState'
import {
  composerLaunchWorkspace,
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from '@/lib/quick-workspace-agent-selection'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { useAgentsOfferedForLaunch } from '@/lib/host-chat-program-acquisition'
import { shouldAllowComposerEnterSubmitTarget } from '@/lib/new-workspace-enter-guard'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { WorkspaceStatus } from '../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace-composer-initial-focus'
import { getFolderWorkspacePrimaryActionLabel } from '@/components/sidebar/folder-workspace-composer-helpers'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

// Why: match App-level AddRepoDialog loading — the add flow is off the hot
// path for the composer, so keep its clone/SSH machinery out of the entry render.
const HostedAddRepoDialog = lazyWithRetry(() => import('@/components/sidebar/AddRepoDialog'), {
  reloadKey: 'composer-add-repo'
})

type ComposerModalData = {
  prefilledName?: string
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  taskSourceContext?: TaskSourceContext | null
  initialWorkspaceTarget?: WorkspaceCreationTargetHint | null
  initialBaseBranch?: string
  initialWorkspaceStatus?: WorkspaceStatus
  enableIssueAutomation?: boolean
  /** Telemetry surface that opened the composer. Set by each
   *  `openModal('new-workspace-composer', ...)` site so
   *  `workspace_created.source` carries the right value. Falls back to
   *  `unknown` when omitted. */
  telemetrySource?: WorkspaceCreateTelemetrySource
  contextualTourSource?: string
  setupGuideTourRequestId?: string
}

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
          // Why: Radix's FocusScope fires this once the dialog has mounted.
          // preventDefault stops it from focusing whatever first-tabbable it
          // picks (close button), and we instead focus the name/source field
          // so users can start typing immediately.
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
    // Why: the modal is quick-create only now, so prompt-prefill state is
    // intentionally ignored even if older callers still send it.
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
  // Why: the composer's built-in `onOpenAgentSettings` handler navigates to
  // the settings page and closes the modal. For the quick-create flow we want
  // a less disruptive affordance — a nested dialog layered over the composer
  // so the user can tweak agents without losing their in-progress workspace
  // name/repo selection.
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  // Why: once the user picks an agent, their choice wins and must not be
  // overwritten when the derived "preferred" value changes (e.g. detection
  // finishes and adds more installed agents to the set). Track that with an
  // override rather than an effect that mirrors a prop into state — deriving
  // during render keeps the selection in sync with the detected set without
  // triggering an extra commit.
  const [quickAgentOverride, setQuickAgentOverride] = useState<TuiAgent | null | undefined>(
    undefined
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
    // Why: detection/settings changes can invalidate a user-picked agent; repair
    // before the child selector renders an unavailable option for one commit.
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
    cardProps.agentRows?.detectionTarget
  )
  const launchSelection = observation.selectionFor(quickAgent, quickAgentSurface)
  const createDisabled = formDisabled || !launchSelection.ready

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
    if (createDisabled) {
      return
    }
    await submitQuick(quickAgent, {
      setupOnly: quickSetupOnly,
      launchChoice: launchSelection.choice
    })
  }, [createDisabled, quickAgent, launchSelection.choice, quickSetupOnly, submitQuick])
  // Why: Add Project layers over the composer as a nested dialog instead of
  // replacing it in the activeModal slot — closing the composer mid-flow (and
  // losing the typed name/prompt) was the old, abrupt behavior. Once opened it
  // stays mounted so cancel/complete plays the close animation and the
  // dialog's close effects can abort in-flight clone/scan work. (Folder/non-git
  // outcomes still navigate away and tear the whole modal down.)
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [addProjectMounted, setAddProjectMounted] = useState(false)
  const [setLocationOpen, setSetLocationOpen] = useState(false)
  const handleOpenAddProject = useCallback((): void => {
    setAddProjectMounted(true)
    setAddProjectOpen(true)
  }, [])
  const handleProjectAdded = useCallback(
    (repoId: string): void => {
      selectAddedProjectRepo(repoId)
    },
    [selectAddedProjectRepo]
  )
  const handleAddProjectCloseAutoFocus = useCallback(
    (event: Event): void => {
      // Why: after adding a project the next step is naming the worktree.
      // Radix would try to restore focus to the (unmounted) combobox row that
      // opened the dialog; send it to the name field instead — the same place
      // picking a project from the combobox lands.
      event.preventDefault()
      nameInputRef?.current?.focus()
    },
    [nameInputRef]
  )
  const addProjectController = useMemo<AddRepoDialogHostedController>(
    () => ({
      open: addProjectOpen,
      onOpenChange: setAddProjectOpen,
      onProjectAdded: handleProjectAdded,
      onProjectGroupImported: selectAddedProjectGroup,
      onCloseAutoFocus: handleAddProjectCloseAutoFocus
    }),
    [addProjectOpen, handleAddProjectCloseAutoFocus, handleProjectAdded, selectAddedProjectGroup]
  )
  const selectedProjectOption = cardProps.projectOptions.find(
    (option) => option.id === cardProps.selectedProjectId
  )
  const isFolderWorkspaceTarget = selectedProjectOption?.kind === 'project-group'
  const primaryActionLabel = isFolderWorkspaceTarget
    ? getFolderWorkspacePrimaryActionLabel()
    : cardProps.selectedRepoIsGit
      ? translate('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
      : translate('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')

  // Cmd/Ctrl+Enter submits. Escape belongs to the dialog's dismissable layer:
  // the page-style "blur the focused field first" rule assumes the user chose
  // that field, but this dialog auto-focuses the name input on open, so handling
  // Escape here swallowed every first press and left the composer stuck open.
  // Radix also closes only the topmost layer, so nested popovers/selects/dialogs
  // keep their own Escape without needing a guard here.
  const nestedDialogOpen = agentSettingsOpen || addProjectOpen || setLocationOpen
  useEffect(() => {
    if (!active || nestedDialogOpen) {
      // Why: while a nested dialog (Add Project / Agents / Set location) is layered
      // on top, this capture-phase handler must not fire composer submit underneath it.
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Why: workspace creation is screen-local submit behavior, not a
      // user-configurable app command.
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
      <NewWorkspaceComposerCard
        contextualTourSource={modalData.contextualTourSource}
        // Keep focus rings and the Advanced hover highlight inside the scroll padding.
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
        onAddProjectOverride={handleOpenAddProject}
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
