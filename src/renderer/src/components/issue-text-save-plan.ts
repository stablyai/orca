import type { IssueTextDraftSource } from './issue-text-draft-state'

export type IssueTextField = 'title' | 'description'

type IssueTextPatch = { title: string } | { description: string }

export type IssueTextSavePlan =
  | { kind: 'changed'; patch: IssueTextPatch }
  | { kind: 'empty-title' }
  | { kind: 'unchanged' }

export function getIssueTextSavePlan({
  descriptionDraft,
  field,
  issue,
  titleDraft
}: {
  descriptionDraft: string
  field: IssueTextField
  issue: Pick<IssueTextDraftSource, 'description' | 'title'>
  titleDraft: string
}): IssueTextSavePlan {
  const nextTitle = titleDraft.trim()
  const nextDescription = descriptionDraft.trimEnd()
  if (field === 'title' && !nextTitle) {
    return { kind: 'empty-title' }
  }

  const nextValue = field === 'title' ? nextTitle : nextDescription
  // Why: description saves strip trailing whitespace, so stored trailing
  // whitespace from the provider should not trigger a no-op save on blur.
  const currentValue = field === 'title' ? issue.title : (issue.description ?? '').trimEnd()
  if (nextValue === currentValue) {
    return { kind: 'unchanged' }
  }

  return field === 'title'
    ? { kind: 'changed', patch: { title: nextTitle } }
    : { kind: 'changed', patch: { description: nextDescription } }
}
