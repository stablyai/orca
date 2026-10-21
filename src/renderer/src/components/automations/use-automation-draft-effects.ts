import { useCallback, useEffect } from 'react'
import type { AutomationTemplate } from './automation-templates'
import { getDefaultWorktree } from './automation-draft-model'
import type { AutomationsPageDestinationState } from './use-automations-page-destination-state'
import type { AutomationsPageDestinationFormState } from './use-automations-page-destination-form'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageRefresh } from './use-automations-page-refresh'
import type { AutomationsPageSetupState } from './use-automations-page-setup-state'

/** Synchronizes draft defaults, setup policy, and templates. */
export function useAutomationDraftEffects({
  local,
  setup,
  destination,
  destinationForm,
  pageRefresh
}: {
  local: AutomationsPageLocalState
  setup: AutomationsPageSetupState
  destination: AutomationsPageDestinationState
  destinationForm: AutomationsPageDestinationFormState
  pageRefresh: AutomationsPageRefresh
}) {
  const {
    draft,
    setDraft,
    createOpen,
    editingAutomationId,
    setupDecisionPolicyDefaultRef,
    setupDecisionDefaultSignatureRef,
    setupDecisionTouchedRef
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
    if (!createOpen || draft.workspaceMode !== 'new_per_run' || !draft.projectId) {
      return
    }
    void loadAutomationYamlHooksForRepo(draft.projectId, createDestinationHostId)
  }, [
    createOpen,
    createDestinationHostId,
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
  return { applyTemplateToDraft }
}

export type AutomationDraftEffects = ReturnType<typeof useAutomationDraftEffects>
