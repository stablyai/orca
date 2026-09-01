// Stateful controller for CustomAgentEditorDialog. It owns the React draft, the
// edit-mode seed fetch, submit orchestration through the single catalog write
// path, and the {repoPath}/{worktreePath} caret-splice. Pure form logic lives in
// custom-agent-editor-state.ts; secret-safe copy lives in custom-agent-editor-copy.ts.

import { useCallback, useEffect, useRef, useState } from 'react'
import { mutateAgentCatalog } from '@/lib/agent-catalog-authoring'
import { useAppStore } from '@/store'
import { isBuiltInTuiAgent } from '../../../../shared/tui-agent-config'
import { measureCustomAgentEnvBytes } from '../../../../shared/custom-tui-agent-fields'
import type { BuiltInTuiAgent, TuiAgent } from '../../../../shared/types'
import {
  buildMutation,
  builtInDraftFromSettings,
  createEnvRow,
  emptyDraft,
  previewArgsTokens,
  resolveMutationErrorFocus,
  serializeEnvRows,
  validateDraftLocally,
  type CustomAgentEditorDraft,
  type CustomAgentEditorMode,
  type CustomAgentEnvRow
} from './custom-agent-editor-state'
import { seedEditDraft, seedRepairEditDraft } from './custom-agent-editor-seed'
import { applyTemplateInsert } from './custom-agent-editor-template-apply'
import {
  describeAgentFieldIssue,
  describeMutationFailure,
  reservedBuiltInLabelError,
  type CustomAgentEditorFieldError,
  type CustomAgentEditorFormError
} from './custom-agent-editor-copy'
import type { ActiveTemplateField, TemplateInsertTarget } from './custom-agent-template-insert'

// Delay before the footer shows "Saving…" so ordinary local persistence does not
// flash a spinner (plan: reserve the label swap until 200 ms have passed).
const SAVING_LABEL_DELAY_MS = 200

export type UseCustomAgentEditor = ReturnType<typeof useCustomAgentEditor>

export function resolveBaseAgent(agent: TuiAgent): BuiltInTuiAgent {
  if (isBuiltInTuiAgent(agent)) {
    return agent
  }
  // `custom-agent:${base}:${uuid}` — the base is the middle segment.
  return agent.split(':')[1] as BuiltInTuiAgent
}

export function useCustomAgentEditor(params: {
  open: boolean
  mode: CustomAgentEditorMode
  initialBaseAgent: BuiltInTuiAgent
  onSaved: (revision: number) => void
  onClose: () => void
}) {
  const { open, mode, initialBaseAgent, onSaved, onClose } = params
  const [draft, setDraft] = useState<CustomAgentEditorDraft>(() => emptyDraft(initialBaseAgent))
  const [loading, setLoading] = useState(false)
  // A failed edit seed must lock the form: saving without the seeded draft would
  // issue update-custom with a blank/stale client draft over the host definition.
  const [seedFailed, setSeedFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [showSaving, setShowSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<CustomAgentEditorFieldError[]>([])
  const [formError, setFormError] = useState<CustomAgentEditorFormError | null>(null)

  const activeFieldRef = useRef<
    (ActiveTemplateField & { element: HTMLTextAreaElement | HTMLInputElement }) | null
  >(null)
  const argsTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const errorSummaryRef = useRef<HTMLDivElement | null>(null)
  const savingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards against a slow edit-seed fetch resolving after the dialog closed/reopened.
  const loadTokenRef = useRef(0)

  const baseAgent =
    mode.kind === 'built-in-launch'
      ? mode.agent
      : mode.kind === 'repair-edit'
        ? mode.baseAgent
        : mode.kind === 'edit' || mode.kind === 'duplicate'
          ? resolveBaseAgent(agentOfMode(mode))
          : // new + repair-replace: the base picker drives the draft.
            draft.baseAgent

  // Static dependency keys for the seed effect (extracted so the linter can check
  // them): the addressed identity per mode, keyed alongside open + mode.kind.
  const editModeId = mode.kind === 'edit' ? mode.id : undefined
  const duplicateSource = mode.kind === 'duplicate' ? agentOfMode(mode) : undefined
  const builtInAgent = mode.kind === 'built-in-launch' ? mode.agent : undefined
  const repairToken =
    mode.kind === 'repair-edit' || mode.kind === 'repair-replace' ? mode.repairToken : undefined

  // Seed the draft each time the dialog opens; identity/revision keying (not a
  // late effect racing typing) resets state on open.
  useEffect(() => {
    if (!open) {
      return
    }
    const token = (loadTokenRef.current += 1)
    setFieldErrors([])
    setFormError(null)
    setSeedFailed(false)
    activeFieldRef.current = null
    // new and repair-replace both start from a blank, base-selectable draft.
    if (mode.kind === 'new' || mode.kind === 'repair-replace') {
      setDraft(emptyDraft(initialBaseAgent))
      setLoading(false)
      return
    }
    if (mode.kind === 'duplicate') {
      setDraft({ ...emptyDraft(baseAgent), envRows: [createEnvRow()] })
      setLoading(false)
      return
    }
    if (mode.kind === 'built-in-launch') {
      // No getLocalDraft locator for built-ins; seed from the live settings maps.
      setDraft(builtInDraftFromSettings(mode.agent, useAppStore.getState().settings))
      setLoading(false)
      return
    }
    // edit and repair-edit both seed one editable record; repair-edit addresses
    // the corrupt physical row by its opaque token instead of by id.
    // Clear the previous session's draft before the fetch: another agent's fields
    // (including env values) must never show under this identity or be saved onto it.
    setDraft(emptyDraft(baseAgent))
    setLoading(true)
    const seed =
      mode.kind === 'repair-edit'
        ? seedRepairEditDraft(mode.repairToken, baseAgent)
        : seedEditDraft(mode.id, baseAgent)
    void seed.then((result) => {
      if (token !== loadTokenRef.current) {
        return
      }
      setLoading(false)
      if (result.kind === 'ready') {
        setDraft(result.draft)
      } else {
        setSeedFailed(true)
        setFormError(result.error)
      }
    })
    // baseAgent is derived from mode; initialBaseAgent only used for new. Do not
    // re-seed on baseAgent change (picking a base in "new" must not reset the draft).
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode.kind, editModeId, duplicateSource, builtInAgent, repairToken])

  useEffect(() => {
    return () => {
      if (savingTimerRef.current) {
        clearTimeout(savingTimerRef.current)
      }
    }
  }, [])

  // Backstop for controls without a wired disabled prop (e.g. the syncEnv
  // switch): a locked form accepts no draft mutation, so a late seed cannot
  // clobber typing and a failed seed cannot be edited around.
  const inputsLocked = loading || seedFailed

  const clearFieldErrors = useCallback((field: CustomAgentEditorFieldError['field']) => {
    setFieldErrors((current) => current.filter((error) => error.field !== field))
    setFormError(null)
  }, [])

  const updateField = useCallback(
    (partial: Partial<CustomAgentEditorDraft>) => {
      if (inputsLocked) {
        return
      }
      setDraft((current) => ({ ...current, ...partial }))
    },
    [inputsLocked]
  )

  const setEnvRows = useCallback(
    (updater: (rows: CustomAgentEnvRow[]) => CustomAgentEnvRow[]) => {
      if (inputsLocked) {
        return
      }
      setDraft((current) => ({ ...current, envRows: updater(current.envRows) }))
      setFieldErrors((current) => current.filter((error) => error.field !== 'env'))
      setFormError(null)
    },
    [inputsLocked]
  )

  const registerTemplateField = useCallback(
    (target: TemplateInsertTarget, element: HTMLTextAreaElement | HTMLInputElement) => {
      activeFieldRef.current = {
        target,
        element,
        selection: { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 }
      }
    },
    []
  )

  const insertPlaceholder = useCallback(
    (placeholder: string) => {
      const active = activeFieldRef.current
      const element = active?.element ?? argsTextareaRef.current
      const target: TemplateInsertTarget = active?.target ?? { kind: 'args' }
      if (!element || inputsLocked) {
        return
      }
      const selection = {
        start: element.selectionStart ?? element.value.length,
        end: element.selectionEnd ?? element.value.length
      }
      applyTemplateInsert({ target, selection, placeholder, element, setDraft })
    },
    [inputsLocked]
  )

  const submit = useCallback(async () => {
    // Refuse until the seed completed for the addressed identity: Enter-to-submit
    // and a re-enabled Save must not write a blank/foreign draft over the record.
    if (submitting || loading || seedFailed) {
      return
    }
    const localIssues = collectLocalIssues(mode, draft)
    if (localIssues.length > 0) {
      setFieldErrors(localIssues)
      focusErrorSummary(errorSummaryRef)
      return
    }
    setFieldErrors([])
    setFormError(null)
    setSubmitting(true)
    savingTimerRef.current = setTimeout(() => setShowSaving(true), SAVING_LABEL_DELAY_MS)
    const result = await mutateAgentCatalog(buildMutation(mode, draft))
    if (savingTimerRef.current) {
      clearTimeout(savingTimerRef.current)
    }
    setSubmitting(false)
    setShowSaving(false)
    if (result.ok) {
      onSaved(result.revision)
      onClose()
      return
    }
    const copy = describeMutationFailure(result, resolveMutationErrorFocus(result))
    if (copy.scope === 'field') {
      setFieldErrors([copy.error])
    } else {
      setFormError(copy.error)
    }
    focusErrorSummary(errorSummaryRef)
  }, [submitting, loading, seedFailed, mode, draft, onSaved, onClose])

  return {
    draft,
    baseAgent,
    loading,
    seedFailed,
    // Field editors and Save disable together: while the seed is in flight (so a
    // late seed cannot clobber typing) and permanently once it has failed.
    inputsLocked,
    submitting,
    showSaving,
    fieldErrors,
    formError,
    tokenizeResult: previewArgsTokens(draft.args),
    envSizeBytes: measureCustomAgentEnvBytes(serializeEnvRows(draft.envRows)),
    refs: { argsTextareaRef, nameInputRef, errorSummaryRef },
    updateField,
    setEnvRows,
    clearFieldErrors,
    registerTemplateField,
    insertPlaceholder,
    submit
  }
}

function agentOfMode(mode: CustomAgentEditorMode): TuiAgent {
  if (mode.kind === 'edit') {
    return mode.id
  }
  if (mode.kind === 'duplicate') {
    return mode.sourceAgent
  }
  // Unreachable for 'new'; the caller guards on mode.kind before calling.
  throw new Error('agentOfMode requires edit or duplicate mode')
}

function collectLocalIssues(
  mode: CustomAgentEditorMode,
  draft: CustomAgentEditorDraft
): CustomAgentEditorFieldError[] {
  const errors: CustomAgentEditorFieldError[] = []
  // Built-ins carry no editable label, so the reserved-name guard does not apply.
  const reserved = mode.kind === 'built-in-launch' ? null : reservedBuiltInLabelError(draft.label)
  if (reserved) {
    errors.push(reserved)
  }
  for (const issue of validateDraftLocally(mode, draft)) {
    // Skip a second label error when the reserved-name check already covered it.
    if (issue.field === 'label' && reserved) {
      continue
    }
    const described = describeAgentFieldIssue(issue)
    if (described) {
      errors.push(described)
    }
  }
  return errors
}

function focusErrorSummary(ref: { current: HTMLDivElement | null }): void {
  requestAnimationFrame(() => ref.current?.focus())
}
