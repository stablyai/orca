import { useCallback } from 'react'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { AUTOMATION_DEFAULT_TIME, getDefaultWorktree } from './automation-draft-model'
import type { AutomationTemplate } from './automation-templates'
import { dispatchAutomationReread } from '../hosts/automation-row-action-dispatch'
import { listAutomationsForTarget } from '../hosts/automation-host-client'
import { automationCreateHostFor } from './automation-create-destination'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { AutomationListRow } from '../listing/automation-list-row-identity'
import type { AutomationsPageDestinationState } from './use-automations-page-destination-state'
import type { AutomationsPageDestinationFormState } from './use-automations-page-destination-form'
import type { AutomationsPageLocalState } from '../use-automations-page-local-state'
import type { AutomationsPageStoreState } from '../use-automations-page-store-state'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

/** Dialog open/edit actions, including host-captured re-reads and project changes. */
export function useAutomationEditorActions({
  store,
  local,
  destination,
  destinationForm
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  destination: AutomationsPageDestinationState
  destinationForm: AutomationsPageDestinationFormState
}) {
  const { defaultAgent, worktreesByRepo, fetchWorktrees } = store
  const {
    editRequestRef,
    setEditingAutomationId,
    setEditingRowKey,
    setEditingDestination,
    setEditingHostStableKey,
    setDraft,
    setDraftAtOpen,
    setTargetEdited,
    setCreateOpen,
    draftRef,
    editingAutomationId,
    editingHostStableKey
  } = local
  const { getDefaultTarget, automationDispatchContext, rowRecoveryHost } = destination
  const { destinationForProject, editHostResolution, editDestinationControl, editHostEntries } =
    destinationForm

  const openCreateDialog = (template?: AutomationTemplate): void => {
    editRequestRef.current += 1
    const target = getDefaultTarget()
    setEditingAutomationId(null)
    setEditingDestination(null)
    setEditingHostStableKey(null)
    const baseDraft: AutomationDraft = {
      name: '',
      prompt: '',
      agentId: defaultAgent,
      extraAgentArgs: '',
      projectId: target.projectId,
      workspaceMode: 'existing',
      workspaceId: target.workspaceId,
      baseBranch: '',
      setupDecision: undefined,
      reuseSession: false,
      precheckCommand: '',
      precheckTimeoutSeconds: '60',
      preset: 'weekdays',
      time: AUTOMATION_DEFAULT_TIME,
      dayOfWeek: '1',
      customSchedule: '',
      missedRunGraceMinutes: '720',
      savedSchedule: null,
      scheduleWarning: null
    }
    const nextDraft = template
      ? {
          ...baseDraft,
          name: template.name,
          prompt: template.prompt,
          preset: template.preset,
          time: template.time ?? baseDraft.time,
          dayOfWeek: template.dayOfWeek ?? baseDraft.dayOfWeek,
          agentId: template.agentId ?? baseDraft.agentId,
          missedRunGraceMinutes: template.missedRunGraceMinutes ?? baseDraft.missedRunGraceMinutes
        }
      : baseDraft
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setTargetEdited(false)
    setCreateOpen(true)
  }

  /** Resolves true once the edit session is set; headless keeps the dialog closed for Migrate. */
  const openEditDialog = async (
    row: AutomationListRow,
    { headless = false }: { headless?: boolean } = {}
  ): Promise<boolean> => {
    const requestId = (editRequestRef.current += 1)
    const automationId = row.automation.id
    const reread = await dispatchAutomationReread(
      automationDispatchContext,
      { rowKey: row.key, automationId },
      async () =>
        (await listAutomationsForTarget({ kind: 'local' })).find(
          (entry) => entry.id === automationId
        ) ?? null
    )
    if (!reread.ok && reread.notice.severity === 'owner') {
      destination.reportOwnerAction(row.key, reread.notice)
      return false
    }
    const latest = (reread.ok ? reread.value : null) ?? row.automation
    if (requestId !== editRequestRef.current) {
      return false
    }
    setEditingAutomationId(latest.id)
    setEditingRowKey(row.key)
    const rowHostStableKey = rowRecoveryHost(row.key)?.stableKey ?? null
    const initialHost = automationCreateHostFor(editHostEntries, rowHostStableKey)
    // A managed SSH host's row can only be saved by moving it to that host's Orca server.
    const movingToServer = initialHost !== null && initialHost.stableKey !== rowHostStableKey
    const initialDestination = destinationForProject(
      latest.projectId,
      initialHost?.stableKey ?? null
    )
    setEditingDestination(
      initialDestination ? { projectId: latest.projectId, destination: initialDestination } : null
    )
    setEditingHostStableKey(
      initialDestination?.entry.stableKey ?? (movingToServer ? initialHost.stableKey : null)
    )
    const nextDraft = buildAutomationEditDraft(latest)
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setTargetEdited(movingToServer)
    setCreateOpen(!headless)
    return true
  }

  const handleProjectChange = useCallback(
    (projectId: string): void => {
      setTargetEdited(true)
      if (
        editDestinationControl.recordedProject?.id === projectId &&
        draftRef.current.projectId === projectId
      ) {
        return
      }
      const currentWorktrees = worktreesByRepo[projectId] ?? []
      const currentDefaultWorktree = getDefaultWorktree(currentWorktrees)
      const selectedEditDestination =
        editingAutomationId !== null && editingHostStableKey
          ? editHostResolution.status === 'ready'
            ? editHostResolution
            : null
          : null
      const worktreeFetchOptions =
        selectedEditDestination?.status === 'ready' &&
        selectedEditDestination.authority.kind === 'runtime'
          ? {
              executionHostId: toRuntimeExecutionHostId(
                selectedEditDestination.authority.environmentId
              )
            }
          : undefined
      if (editingAutomationId !== null) {
        const target = destinationForProject(projectId, editingHostStableKey)
        setEditingDestination(target ? { projectId, destination: target } : null)
        if (target) {
          setEditingHostStableKey(target.entry.stableKey)
        }
      }
      setDraft((current) => ({
        ...current,
        projectId,
        workspaceId: currentDefaultWorktree?.id ?? '',
        baseBranch: ''
      }))
      void fetchWorktrees(projectId, worktreeFetchOptions).then(() => {
        const latestWorktrees = selectWorktreesByRepo(useAppStore.getState())[projectId] ?? []
        const latestWorktree = getDefaultWorktree(latestWorktrees)
        if (!latestWorktree) {
          return
        }
        setDraft((current) =>
          current.projectId === projectId && !current.workspaceId
            ? { ...current, workspaceId: latestWorktree.id }
            : current
        )
      })
    },
    [
      destinationForProject,
      editDestinationControl.recordedProject,
      draftRef,
      editingAutomationId,
      editingHostStableKey,
      editHostResolution,
      fetchWorktrees,
      setEditingHostStableKey,
      setEditingDestination,
      setDraft,
      setTargetEdited,
      worktreesByRepo
    ]
  )
  const handleDraftChange = useCallback(
    (updater: (current: AutomationDraft) => AutomationDraft): void => {
      const current = draftRef.current
      const next = updater(current)
      draftRef.current = next
      setDraft(next)
      if (
        editingAutomationId !== null &&
        (next.projectId !== current.projectId ||
          next.workspaceId !== current.workspaceId ||
          next.workspaceMode !== current.workspaceMode)
      ) {
        setTargetEdited(true)
        const target = destinationForProject(next.projectId, editingHostStableKey)
        setEditingDestination(target ? { projectId: next.projectId, destination: target } : null)
        if (target) {
          setEditingHostStableKey(target.entry.stableKey)
        }
      }
    },
    [
      destinationForProject,
      draftRef,
      editingAutomationId,
      editingHostStableKey,
      setDraft,
      setTargetEdited,
      setEditingDestination,
      setEditingHostStableKey
    ]
  )

  return {
    openCreateDialog,
    openEditDialog,
    handleProjectChange,
    handleDraftChange
  }
}

export type AutomationEditorActions = ReturnType<typeof useAutomationEditorActions>
