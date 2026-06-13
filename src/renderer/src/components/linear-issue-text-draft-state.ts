import type { LinearIssue } from '../../../shared/types'

type LinearIssueTextDraftSource = Pick<LinearIssue, 'description' | 'id' | 'title'>

export type LinearIssueTextDraftState = {
  issueId: string
  sourceTitle: string
  sourceDescription: string
  title: string
  description: string
}

function getLinearIssueDescription(issue: LinearIssueTextDraftSource): string {
  return issue.description ?? ''
}

export function createLinearIssueTextDraftState(
  issue: LinearIssueTextDraftSource
): LinearIssueTextDraftState {
  const description = getLinearIssueDescription(issue)
  return {
    issueId: issue.id,
    sourceTitle: issue.title,
    sourceDescription: description,
    title: issue.title,
    description
  }
}

export function resolveLinearIssueTextDraftState(
  state: LinearIssueTextDraftState,
  issue: LinearIssueTextDraftSource
): LinearIssueTextDraftState {
  const sourceDescription = getLinearIssueDescription(issue)
  if (state.issueId !== issue.id) {
    return createLinearIssueTextDraftState(issue)
  }
  if (state.sourceTitle === issue.title && state.sourceDescription === sourceDescription) {
    return state
  }
  return {
    issueId: state.issueId,
    sourceTitle: issue.title,
    sourceDescription,
    title: state.title === state.sourceTitle ? issue.title : state.title,
    description:
      state.description === state.sourceDescription ? sourceDescription : state.description
  }
}
