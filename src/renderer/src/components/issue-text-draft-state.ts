/** Title and description of a provider issue; YouTrack maps its summary to `title`. */
export type IssueTextDraftSource = { id: string; title: string; description?: string }

export type IssueTextDraftState = {
  issueId: string
  sourceTitle: string
  sourceDescription: string
  title: string
  description: string
}

function getIssueDescription(issue: IssueTextDraftSource): string {
  return issue.description ?? ''
}

export function createIssueTextDraftState(issue: IssueTextDraftSource): IssueTextDraftState {
  const description = getIssueDescription(issue)
  return {
    issueId: issue.id,
    sourceTitle: issue.title,
    sourceDescription: description,
    title: issue.title,
    description
  }
}

export function resolveIssueTextDraftState(
  state: IssueTextDraftState,
  issue: IssueTextDraftSource
): IssueTextDraftState {
  const sourceDescription = getIssueDescription(issue)
  if (state.issueId !== issue.id) {
    return createIssueTextDraftState(issue)
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
