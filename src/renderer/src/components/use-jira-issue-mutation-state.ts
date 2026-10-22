import {
  useEffect,
  useEffectEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import type { JiraIssue } from '../../../shared/jira-types'
import { subscribeJiraIssueMutation } from './jira-issue-mutation-queue'
import {
  editedJiraIssueFields,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'

export function useJiraIssueMutationState({
  scope,
  issue,
  displayed,
  editedFieldsRef,
  setFullIssue,
  setTitleDraft,
  setLabelsDraft,
  onStatusSettled,
  onCommentsChanged
}: {
  scope: string | null
  issue: JiraIssue | null
  displayed: JiraIssue | null
  editedFieldsRef: RefObject<Set<EditableJiraIssueField>>
  setFullIssue: Dispatch<SetStateAction<JiraIssue | null>>
  setTitleDraft: Dispatch<SetStateAction<string>>
  setLabelsDraft: Dispatch<SetStateAction<string>>
  onStatusSettled: () => void
  onCommentsChanged: () => void
}): void {
  const applyPatch = useEffectEvent(
    (
      patch: Partial<JiraIssue>,
      _rollback: boolean,
      statusSettled: boolean,
      commentsChanged: boolean,
      previous = displayed
    ) => {
      if (!previous) {
        return
      }
      for (const field of editedJiraIssueFields(patch)) {
        editedFieldsRef.current.add(field)
      }
      setFullIssue((current) => (current ? { ...current, ...patch } : current))
      const title = patch.title
      if (title !== undefined) {
        setTitleDraft((draft) => (draft === previous.title ? title : draft))
      }
      const labels = patch.labels
      if (labels !== undefined) {
        setLabelsDraft((draft) =>
          draft === previous.labels.join(', ') ? labels.join(', ') : draft
        )
      }
      if (commentsChanged) {
        onCommentsChanged()
      }
      if (statusSettled) {
        onStatusSettled()
      }
    }
  )
  const replayPatch = useEffectEvent((patch: Partial<JiraIssue>) =>
    applyPatch(patch, false, false, false, issue)
  )
  useEffect(() => {
    if (!scope) {
      return
    }
    return subscribeJiraIssueMutation(scope, applyPatch, replayPatch)
  }, [scope])
}
