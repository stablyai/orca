import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
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
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from '@/lib/quick-workspace-agent-selection'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldAllowComposerEnterSubmitTarget } from '@/lib/new-workspace-enter-guard'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type {
  TuiAgent,
  WorkspaceCreateTelemetrySource,
  WorkspaceStatus
} from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace-composer-initial-focus'
import { getFolderWorkspacePrimaryActionLabel } from '@/components/sidebar/folder-workspace-composer-helpers'

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
  taskSourceContext?: TaskSourceContext | null
  initialBaseBranch?: string
  initialWorkspaceStatus?: WorkspaceStatus
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

  // Why: Dialog open-state transitions must be driven by the store, not a
  // mirror useState, so palette/open-modal calls feel instantaneous and the
  // modal doesn't linger with stale data after close.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  if (!visible) {
    return null
  }

  return (
    <ComposerModalBody
      modalData={modalData ?? {}}
      onClose={closeModal}
      onOpenChange={handleOpenChange}
    />
  )
}

function ComposerModalBody({
  modalData,
  onClose,
  onOpenChange
}: {
  modalData: ComposerModalData
  onClose: () => void
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-lg"
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
        <QuickTabBody modalData={modalData} onClose={onClose} active />
      </DialogContent>
    </Dialog>
  )
}

function QuickTabBody({
  modalData,
  onClose,
  active
}: {
  modalData: ComposerModalData
  onClose: () => void
  active: boolean
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const {
    cardProps,
    composerRef,
    onComposerNodeChange,
    nameInputRef,
    submitQuick,
    createDisabled,
    selectAddedProjectRepo
  } = useComposerState({
    initialName: modalData.prefilledName ?? '',
    // Why: the modal is quick-create only now, so prompt-prefill state is
    // intentionally ignored even if older callers still send it.
    initialPrompt: '',
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialTaskSourceContext: modalData.taskSourceContext ?? null,
    initialRepoId: modalData.initialRepoId,
    initialEphemeralVmRecipeId: modalData.initialEphemeralVmRecipeId,
    initialProjectGroupId: modalData.initialProjectGroupId,
    initialWorkspaceStatus: modalData.initialWorkspaceStatus,
    ...(modalData.initialBaseBranch ? { initialBaseBranch: modalData.initialBaseBranch } : {}),
    persistDraft: false,
    onCreated: onClose,
    ...(modalData.telemetrySource ? { telemetrySource: modalData.telemetrySource } : {}),
    enableIssueAutomation: false,
    createGateMode: 'quick'
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
  const preferredQuickAgent = useMemo<TuiAgent | null>(() => {
    const pref = settings?.defaultTuiAgent
    // Why: detection can still be pending when quick-create submits; keep the
    // prior catalog fallback while filtering disabled agents out of that choice.
    return pickQuickWorkspaceAgent(pref, cardProps.detectedAgentIds, settings?.disabledTuiAgents)
  }, [cardProps.detectedAgentIds, settings?.defaultTuiAgent, settings?.disabledTuiAgents])
  const resolvedQuickAgentSelection = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride,
    preferredQuickAgent,
    detectedAgentIds: cardProps.detectedAgentIds,
    disabledTuiAgents: settings?.disabledTuiAgents
  })
  if (resolvedQuickAgentSelection.quickAgentOverride !== quickAgentOverride) {
    // Why: detection/settings changes can invalidate a user-picked agent; repair
    // before the child selector renders an unavailable option for one commit.
    setQuickAgentOverride(resolvedQuickAgentSelection.quickAgentOverride)
  }
  const quickAgent = resolvedQuickAgentSelection.quickAgent

  const handleQuickAgentChange = useCallback((agent: TuiAgent | null) => {
    setQuickAgentOverride(agent)
  }, [])

  const handleCreate = useCallback(async (): Promise<void> => {
    await submitQuick(quickAgent)
  }, [quickAgent, submitQuick])
  // Why: Add Project layers over the composer as a nested dialog instead of
  // replacing it in the activeModal slot — closing the composer mid-flow (and
  // losing the typed name/prompt) was the old, abrupt behavior. Once opened it
  // stays mounted so cancel/complete plays the close animation and the
  // dialog's close effects can abort in-flight clone/scan work. (Folder/non-git
  // outcomes still navigate away and tear the whole modal down.)
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [addProjectMounted, setAddProjectMounted] = useState(false)
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
      onCloseAutoFocus: handleAddProjectCloseAutoFocus
    }),
    [addProjectOpen, handleAddProjectCloseAutoFocus, handleProjectAdded]
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

  // Cmd/Ctrl+Enter submits, Esc first blurs the focused input (like the full page).
  const nestedDialogOpen = agentSettingsOpen || addProjectOpen
  useEffect(() => {
    if (!active || nestedDialogOpen) {
      // Why: while a nested dialog (Add Project / Agents) is layered on top,
      // this capture-phase handler must not steal its Escape (which should
      // close only the nested dialog) or fire composer submit underneath it.
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== 'Escape') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (event.key === 'Escape') {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable
        ) {
          event.preventDefault()
          target.blur()
          return
        }
        event.preventDefault()
        onClose()
        return
      }

      // Why: workspace creation is screen-local submit behavior, not a
      // user-configurable app command.
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      if (!shouldAllowComposerEnterSubmitTarget(target, composerRef.current)) {
        return
      }
      if (createDisabled) {
        return
      }
      event.preventDefault()
      void handleCreate()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [active, composerRef, createDisabled, handleCreate, nestedDialogOpen, onClose])

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
            'auto.components.NewWorkspaceComposerModal.fa90f739a5',
            'Choose the project, workspace name, and agent before creating the workspace.'
          )}
        </DialogDescription>
      </DialogHeader>
      <NewWorkspaceComposerCard
        contextualTourSource={modalData.contextualTourSource}
        // Why: the scroll container clips children (overflow-y-auto forces overflow-x to auto),
        // while Orca's standard field focus ring paints 3px outside the control and the ghost
        // "Advanced" disclosure pulls its padded hover highlight ~8px left to align its label with
        // the field labels. Inset px-2 so both stay fully visible instead of clipped at the edge.
        containerClassName="min-h-0 flex-1 overflow-y-auto px-2 scrollbar-sleek"
        composerRef={composerRef}
        onComposerNodeChange={onComposerNodeChange}
        nameInputRef={nameInputRef}
        quickAgent={quickAgent}
        onQuickAgentChange={handleQuickAgentChange}
        {...cardProps}
        primaryActionLabel={primaryActionLabel}
        onOpenAgentSettings={() => setAgentSettingsOpen(true)}
        onCreate={() => void handleCreate()}
        onAddProjectOverride={handleOpenAddProject}
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
