import { useState } from 'react'
import { toast } from 'sonner'
import { IssueMarkdownDescriptionEditor } from '@/components/editor/IssueMarkdownDescriptionEditor'
import { IssueTitleField } from '@/components/editor/IssueTitleField'
import { createIssueTextDraftState, resolveIssueTextDraftState } from '../issue-text-draft-state'
import { getIssueTextSavePlan, type IssueTextField } from '../issue-text-save-plan'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getScreenSubmitShortcutLabel } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import type { YouTrackIssue } from '../../../../shared/youtrack-types'

function toTextSource(issue: YouTrackIssue): { id: string; title: string; description?: string } {
  return { id: issue.idReadable, title: issue.summary, description: issue.description }
}

/** Edits a YouTrack issue's summary or description in place, like Linear's issue text. */
export function YouTrackIssueTextEditor({
  issue,
  field,
  onIssueChanged
}: {
  issue: YouTrackIssue
  field: IssueTextField
  onIssueChanged: (issue: YouTrackIssue) => void
}): React.JSX.Element {
  const source = toTextSource(issue)
  const [draftState, setDraftState] = useState(() => createIssueTextDraftState(source))
  const [saving, setSaving] = useState(false)
  const mountedRef = useMountedRef()
  const resolved = resolveIssueTextDraftState(draftState, source)
  if (resolved !== draftState) {
    // Reconcile untouched drafts with YouTrack before the next paint.
    setDraftState(resolved)
  }

  const setDraft = (patch: { title: string } | { description: string }): void =>
    setDraftState((current) => ({ ...resolveIssueTextDraftState(current, source), ...patch }))

  const save = async (description = resolved.description): Promise<void> => {
    const api = window.api.youtrack
    const plan = getIssueTextSavePlan({
      field,
      issue: source,
      titleDraft: resolved.title,
      descriptionDraft: description
    })
    if (plan.kind === 'empty-title') {
      setDraft({ title: issue.summary })
      toast.error(translate('youtrack.detail.summaryRequired', 'Summary is required'))
      return
    }
    if (plan.kind === 'unchanged' || !api || saving) {
      return
    }
    setSaving(true)
    const result = await api.updateText(
      'title' in plan.patch
        ? { idReadable: issue.idReadable, summary: plan.patch.title }
        : { idReadable: issue.idReadable, description: plan.patch.description }
    )
    if (!mountedRef.current) {
      return
    }
    setSaving(false)
    if (result.ok) {
      onIssueChanged(result.issue)
      return
    }
    setDraft(
      field === 'title' ? { title: issue.summary } : { description: issue.description ?? '' }
    )
    toast.error(result.error)
  }

  if (field === 'title') {
    return (
      <IssueTitleField
        value={resolved.title}
        onChange={(title) => setDraft({ title })}
        onSave={() => void save()}
        saving={saving}
        className="text-[20px] font-semibold leading-tight"
      />
    )
  }
  return (
    <IssueMarkdownDescriptionEditor
      value={resolved.description}
      onChange={(description) => setDraft({ description })}
      onSave={(description) => {
        setDraft({ description })
        void save(description)
      }}
      density="drawer"
      disabled={saving}
      submitShortcutLabel={getScreenSubmitShortcutLabel()}
    />
  )
}
