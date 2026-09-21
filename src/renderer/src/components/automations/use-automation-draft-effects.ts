import { useCallback, useEffect } from 'react'
import type { AutomationTemplate } from './automation-templates'
import type { AutomationCreateTarget } from './AutomationEditorDialog'
import { getAutomationCreateRepos } from './automation-create-projects'
import { getDefaultWorktree } from './automation-draft-model'
import type { AutomationsPageDestinationState } from './use-automations-page-destination-state'
import type { AutomationsPageDestinationFormState } from './use-automations-page-destination-form'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageRefresh } from './use-automations-page-refresh'
import type { AutomationsPageSetupState } from './use-automations-page-setup-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Synchronizes draft defaults, setup policy, and template/target controls. */
export function useAutomationDraftEffects({
  store,
  local,
  setup,
  destination,
  destinationForm,
  pageRefresh
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  setup: AutomationsPageSetupState
  destination: AutomationsPageDestinationState
  destinationForm: AutomationsPageDestinationFormState
  pageRefresh: AutomationsPageRefresh
}) {
  const { repos, worktreesByRepo } = store
  const {
    draft,
    setDraft,
    createOpen,
    createTarget,
    editingAutomationId,
    setupDecisionPolicyDefaultRef,
    setupDecisionDefaultSignatureRef,
    setupDecisionTouchedRef,
    setCreateTarget
  } = local
  const {
    loadAutomationYamlHooksForRepo,
    getDraftSetupDecisionDefault,
    getDraftSetupDecisionDefaultSignature
  } = setup
  const { createDestinationHostId } = destination
  const { dialogWorktrees } = destinationForm
  const { getDefaultTarget } = pageRefresh

  useEffect(() => {
    if (!draft.projectId && editingAutomationId === null) {
      const target = getDefaultTarget()
      if (!target.projectId) {
        return
      }
      setDraft((current) => ({
        ...current,
        projectId: target.projectId,
        workspaceId: target.workspaceId
      }))
    }
  }, [draft.projectId, editingAutomationId, getDefaultTarget, setDraft])
  useEffect(() => {
    if (!draft.projectId) {
      return
    }
    const defaultWorktree = getDefaultWorktree(dialogWorktrees)
    if (!draft.workspaceId && defaultWorktree) {
      setDraft((current) => ({ ...current, workspaceId: defaultWorktree.id }))
    }
  }, [dialogWorktrees, draft.projectId, draft.workspaceId, setDraft])
  useEffect(() => {
    if (
      !createOpen ||
      createTarget !== 'orca' ||
      draft.workspaceMode !== 'new_per_run' ||
      !draft.projectId
    ) {
      return
    }
    void loadAutomationYamlHooksForRepo(draft.projectId, createDestinationHostId)
  }, [
    createOpen,
    createDestinationHostId,
    createTarget,
    draft.projectId,
    draft.workspaceMode,
    loadAutomationYamlHooksForRepo
  ])
  useEffect(() => {
    if (!createOpen) {
      setupDecisionPolicyDefaultRef.current = undefined
      setupDecisionDefaultSignatureRef.current = null
      setupDecisionTouchedRef.current = false
      return
    }
    const nextDefault = getDraftSetupDecisionDefault(draft)
    const nextSignature = getDraftSetupDecisionDefaultSignature(draft)
    if (setupDecisionDefaultSignatureRef.current !== nextSignature) {
      setupDecisionDefaultSignatureRef.current = nextSignature
      setupDecisionTouchedRef.current = false
    }
    const previousDefault = setupDecisionPolicyDefaultRef.current
    setupDecisionPolicyDefaultRef.current = nextDefault
    const shouldApplyPolicyDefault =
      !setupDecisionTouchedRef.current &&
      (nextDefault === undefined ||
        draft.setupDecision === undefined ||
        draft.setupDecision === previousDefault)
    if (!shouldApplyPolicyDefault || draft.setupDecision === nextDefault) {
      return
    }
    setDraft((current) => ({ ...current, setupDecision: nextDefault }))
  }, [
    createOpen,
    draft,
    getDraftSetupDecisionDefault,
    getDraftSetupDecisionDefaultSignature,
    setDraft,
    setupDecisionDefaultSignatureRef,
    setupDecisionPolicyDefaultRef,
    setupDecisionTouchedRef
  ])

  const applyTemplateToDraft = useCallback(
    (template: AutomationTemplate): void => {
      setDraft((current) => ({
        ...current,
        name: template.name,
        prompt: template.prompt,
        preset: template.preset,
        time: template.time ?? current.time,
        dayOfWeek: template.dayOfWeek ?? current.dayOfWeek,
        customSchedule: '',
        agentId: template.agentId ?? current.agentId,
        missedRunGraceMinutes: template.missedRunGraceMinutes ?? current.missedRunGraceMinutes,
        scheduleWarning: null
      }))
    },
    [setDraft]
  )
  const handleCreateTargetChange = useCallback(
    (target: AutomationCreateTarget): void => {
      setCreateTarget(target)
      if (target !== 'hermes') {
        return
      }
      const localRepos = getAutomationCreateRepos(repos, { kind: 'local' })
      setDraft((current) => {
        const currentRepo = repos.find((repo) => repo.id === current.projectId)
        const currentRepoIsLocal =
          currentRepo !== undefined &&
          localRepos.some(
            (repo) =>
              repo.id === currentRepo.id &&
              (repo.connectionId ?? null) === (currentRepo.connectionId ?? null)
          )
        const nextRepo = currentRepoIsLocal ? currentRepo : localRepos[0]
        const nextWorkspace = nextRepo
          ? getDefaultWorktree(worktreesByRepo[nextRepo.id] ?? [])
          : null
        return {
          ...current,
          agentId: 'hermes',
          projectId: nextRepo?.id ?? '',
          workspaceId: nextWorkspace?.id ?? '',
          workspaceMode: 'existing',
          setupDecision: undefined,
          reuseSession: false
        }
      })
    },
    [repos, setCreateTarget, setDraft, worktreesByRepo]
  )

  return { applyTemplateToDraft, handleCreateTargetChange }
}

export type AutomationDraftEffects = ReturnType<typeof useAutomationDraftEffects>
