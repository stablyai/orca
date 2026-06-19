import type { LinearIssue } from '../../../shared/types'

export type LinearIssueTextField = 'title' | 'description'

type LinearIssueTextPatch = Pick<LinearIssue, 'title'> | Pick<LinearIssue, 'description'>

export type LinearIssueTextSavePlan =
  | { kind: 'changed'; patch: LinearIssueTextPatch }
  | { kind: 'empty-title' }
  | { kind: 'unchanged' }

export function getLinearIssueTextSavePlan({
  descriptionDraft,
  field,
  issue,
  titleDraft
}: {
  descriptionDraft: string
  field: LinearIssueTextField
  issue: Pick<LinearIssue, 'description' | 'title'>
  titleDraft: string
}): LinearIssueTextSavePlan {
  const nextTitle = titleDraft.trim()
  const nextDescription = descriptionDraft.trimEnd()
  if (field === 'title' && !nextTitle) {
    return { kind: 'empty-title' }
  }

  const nextValue = field === 'title' ? nextTitle : nextDescription
  // Why: description saves strip trailing whitespace, so stored trailing
  // whitespace from Linear should not trigger a no-op PATCH on blur.
  const currentValue = field === 'title' ? issue.title : (issue.description ?? '').trimEnd()
  if (nextValue === currentValue) {
    return { kind: 'unchanged' }
  }

  return field === 'title'
    ? { kind: 'changed', patch: { title: nextTitle } }
    : { kind: 'changed', patch: { description: nextDescription } }
}
