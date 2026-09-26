import { toast } from 'sonner'
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import { buildAutomationRrule } from '../../../../shared/automation-schedule-occurrences'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { listAutomationsForTarget } from './automation-host-client'
import {
  dispatchAutomationReread,
  type AutomationDispatchResult
} from './automation-row-action-dispatch'
import { buildDraftPrecheck } from './automation-draft-model'
import {
  createAutomationCopiesForExtraProjects,
  normalizeAutomationCreateTargets,
  planAutomationProjectRun
} from './automation-project-run-plan'
import {
  createAutomationOnDestination,
  moveAutomationToDestination,
  resolveAutomationEditDestination,
  saveExistingAutomation
} from './automation-orca-save-operations'
import type { AutomationSaveContext } from './automation-save-context'

/** Saves an Orca automation, including destination validation and host moves. */
export async function saveOrcaAutomation(
  context: AutomationSaveContext,
  time: { hour: number; minute: number; now: number }
): Promise<void> {
  const { store, local, destination, destinationForm, pageRefresh } = context
  const { repos } = store
  const {
    draft,
    editingAutomationId,
    editingRowKey,
    editingDestination,
    automations,
    setAutomations,
    setDraft,
    selectAutomationId,
    setSelectedRowKey,
    setSelectedAutomationRunPageId,
    setCreateOpen,
    setEditorNotice,
    setEditorNoticeHost,
    moveCreationKeysRef
  } = local
  const {
    automationHostTarget,
    automationDispatchContext,
    invalidateRowHost,
    invalidateWrittenHost,
    rowRecoveryHost,
    createDestination
  } = destination
  const { dialogRepos, editHostResolution, automationDialogTarget } = destinationForm

  // Re-check the destination at the start of the transaction. This keeps all
  // side effects (hook probes and trust prompts) behind the destination fence.
  const createCheck = editingAutomationId === null ? createDestination.check(draft.projectId) : null
  if (createCheck && !createCheck.ok) {
    setEditorNotice(createCheck.notice)
    return
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const rrule =
    draft.preset === 'custom'
      ? draft.customSchedule.trim()
      : buildAutomationRrule({
          preset: draft.preset,
          hour: time.hour,
          minute: time.minute,
          dayOfWeek: Number(draft.dayOfWeek)
        })
  const rawGrace = Number(draft.missedRunGraceMinutes)
  const missedRunGraceMinutes = Number.isFinite(rawGrace) ? Math.max(0, rawGrace) : 720
  const precheck = buildDraftPrecheck(draft)
  const reposForDraft = editingAutomationId !== null ? dialogRepos : repos
  const { extraProjectIds, workspaceMode } =
    editingAutomationId === null
      ? normalizeAutomationCreateTargets(draft)
      : { extraProjectIds: [], workspaceMode: draft.workspaceMode }
  const reuseSession = workspaceMode === 'existing' && draft.reuseSession
  const setupResolution =
    editingAutomationId !== null
      ? editHostResolution
      : createCheck
        ? { status: 'ready' as const, ...createCheck.destination }
        : null
  const plan = await planAutomationProjectRun(context, {
    projectId: draft.projectId,
    repos: reposForDraft,
    authority: setupResolution?.status === 'ready' ? setupResolution.authority : null,
    workspaceMode,
    draftSetupDecision: draft.setupDecision
  })
  if (!plan) {
    toast.error(
      translate(
        'auto.components.automations.AutomationsPage.32534e7c9c',
        'Choose an available workspace before saving.'
      )
    )
    return
  }
  const { setupDecision, runContext } = plan

  let currentAutomation = editingAutomationId
    ? (automations.find((automation) => automation.id === editingAutomationId) ?? null)
    : null
  if (editingAutomationId !== null) {
    const reread = await dispatchAutomationReread(
      automationDispatchContext,
      { rowKey: editingRowKey ?? '', automationId: editingAutomationId },
      async () =>
        (await listAutomationsForTarget(automationHostTarget ?? { kind: 'local' })).find(
          (automation) => automation.id === editingAutomationId
        ) ?? null
    )
    if (!reread.ok && reread.notice.severity === 'owner') {
      setEditorNotice(reread.notice)
      return
    }
    currentAutomation = (reread.ok ? reread.value : null) ?? currentAutomation
  }

  const updates: AutomationUpdateInput = {
    name: draft.name,
    prompt: draft.prompt,
    precheck,
    agentId: draft.agentId,
    runContext,
    projectId: draft.projectId,
    workspaceMode,
    workspaceId: draft.workspaceId,
    baseBranch: draft.baseBranch.trim() || null,
    setupDecision,
    reuseSession,
    timezone,
    missedRunGraceMinutes
  }
  if (!currentAutomation || currentAutomation.rrule !== rrule) {
    updates.rrule = rrule
    updates.dtstart = time.now
  }
  const createInput: AutomationCreateInput = {
    name: draft.name,
    prompt: draft.prompt,
    precheck,
    agentId: draft.agentId,
    runContext,
    projectId: draft.projectId,
    workspaceMode,
    workspaceId: draft.workspaceId,
    baseBranch: draft.baseBranch.trim() || null,
    setupDecision,
    reuseSession,
    timezone,
    rrule,
    dtstart: updates.dtstart ?? time.now,
    missedRunGraceMinutes
  }

  const destinationResult = resolveAutomationEditDestination({
    currentAutomation,
    editingAutomationId,
    editingDestination,
    draft,
    rowKey: editingRowKey,
    automationDialogTarget,
    editHostEntries: destinationForm.editHostEntries,
    rowRecoveryHost
  })
  if (!destinationResult.ok) {
    setEditorNotice(destinationResult.notice)
    return
  }
  const { editDestination, moveTarget } = destinationResult

  let saved: AutomationDispatchResult<Automation>
  let originalRemoved = true
  if (moveTarget) {
    const moved = await moveAutomationToDestination(
      {
        automationDispatchContext,
        editingRowKey,
        automationDialogTarget,
        moveCreationKeysRef,
        invalidateWrittenHost
      },
      currentAutomation,
      moveTarget,
      {
        ...createInput,
        dtstart: updates.dtstart ?? currentAutomation?.dtstart ?? createInput.dtstart,
        enabled: currentAutomation?.enabled ?? true,
        sourceContext: currentAutomation?.sourceContext ?? null
      }
    )
    saved = moved.saved
    originalRemoved = moved.originalRemoved
  } else if (editingAutomationId !== null) {
    saved = await saveExistingAutomation(
      context,
      editingAutomationId,
      currentAutomation,
      updates,
      editDestination,
      automationHostTarget,
      editingRowKey
    )
  } else {
    saved = await createAutomationOnDestination(
      createCheck!.destination.authority,
      createInput,
      createCheck!.destination,
      invalidateWrittenHost
    )
  }
  if (!saved.ok) {
    setEditorNotice(saved.notice)
    setEditorNoticeHost(moveTarget?.entry ?? null)
    return
  }
  const automation = saved.value
  const copies =
    extraProjectIds.length > 0
      ? await createAutomationCopiesForExtraProjects(context, extraProjectIds, createInput)
      : null
  if (editingAutomationId !== null) {
    invalidateRowHost(editingRowKey, 'definition')
  } else {
    await pageRefresh.hydratePersistedUIState()
  }
  setAutomations((current) => {
    const written = [automation, ...(copies?.created ?? [])]
    const writtenIds = new Set(written.map((entry) => entry.id))
    const next = current.filter((entry) => !writtenIds.has(entry.id))
    return [...next, ...written].sort((left, right) => left.name.localeCompare(right.name))
  })
  setDraft((current) => ({ ...current, name: '', prompt: '', extraProjectIds: [] }))
  await pageRefresh.refresh()
  if (editingAutomationId !== null && editingRowKey && !moveTarget) {
    setSelectedAutomationRunPageId(null)
    setSelectedRowKey(editingRowKey)
  }
  selectAutomationId(automation.id)
  setCreateOpen(false)
  if (editingAutomationId === null) {
    useAppStore.getState().recordFeatureInteraction('automation-created')
  }
  if (moveTarget && !originalRemoved) {
    return
  }
  if (copies?.failed.length) {
    toast.error(
      translate(
        'auto.components.automations.AutomationsPage.copiesFailed',
        'Saved, but no copy was created in: {{projects}}',
        { projects: copies.failed.join(', ') }
      )
    )
  }
  if (copies && copies.created.length > 0) {
    toast.success(
      translate(
        'auto.components.automations.AutomationsPage.savedInProjects',
        'Automation saved in {{count}} projects.',
        { count: copies.created.length + 1 }
      )
    )
    return
  }
  toast.success(
    moveTarget
      ? translate(
          'auto.components.automations.AutomationsPage.moved',
          'Automation moved to {host}.'
        ).replace('{host}', () => moveTarget.entry.authorityLabel)
      : editingAutomationId !== null
        ? translate('auto.components.automations.AutomationsPage.244727e655', 'Automation updated.')
        : translate('auto.components.automations.AutomationsPage.2a20596d6b', 'Automation saved.')
  )
}
