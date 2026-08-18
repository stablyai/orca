import type {
  DashboardCard,
  DashboardCardReview,
  DashboardWorkspace
} from '../../../../shared/dashboard-snapshot'

export type DashboardReviewFilter = DashboardCardReview['state'] | 'none'

export type DashboardFilters = {
  projects: string[]
  workspaceStatuses: string[]
  reviewStates: DashboardReviewFilter[]
}

export const EMPTY_DASHBOARD_FILTERS: DashboardFilters = {
  projects: [],
  workspaceStatuses: [],
  reviewStates: []
}

export function activeDashboardFilterCount(filters: DashboardFilters): number {
  return filters.projects.length + filters.workspaceStatuses.length + filters.reviewStates.length
}

function cardSearchText(card: DashboardCard): string {
  return [
    card.worktreeName,
    card.repoName,
    card.agentType,
    card.conversationName,
    card.task,
    card.lastUserMessage,
    card.lastAgentMessage,
    card.askSummary,
    card.review ? `#${card.review.number}` : '',
    ...(card.subagents?.map((subagent) => subagent.name) ?? [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
}

function workspaceSearchText(workspace: DashboardWorkspace): string {
  return [
    workspace.worktreeName,
    workspace.repoName,
    workspace.review ? `#${workspace.review.number}` : ''
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
}

function workspaceMatchesFilters(
  workspace: DashboardWorkspace,
  normalizedQuery: string,
  filters: DashboardFilters
): boolean {
  const reviewState = workspace.review?.state ?? (workspace.hasReview ? null : 'none')
  return (
    (normalizedQuery.length === 0 || workspaceSearchText(workspace).includes(normalizedQuery)) &&
    (filters.projects.length === 0 || filters.projects.includes(workspace.repoId)) &&
    (filters.workspaceStatuses.length === 0 ||
      (workspace.workspaceStatusId !== undefined &&
        filters.workspaceStatuses.includes(workspace.workspaceStatusId))) &&
    (filters.reviewStates.length === 0 ||
      (reviewState !== null && filters.reviewStates.includes(reviewState)))
  )
}

export function filterDashboardCards(
  cards: DashboardCard[],
  query: string,
  filters: DashboardFilters
): DashboardCard[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return cards.filter((card) => {
    const reviewState = card.review?.state ?? (card.hasReview ? null : 'none')
    return (
      (normalizedQuery.length === 0 || cardSearchText(card).includes(normalizedQuery)) &&
      (filters.projects.length === 0 || filters.projects.includes(card.repoId)) &&
      (filters.workspaceStatuses.length === 0 ||
        (card.workspaceStatusId !== undefined &&
          filters.workspaceStatuses.includes(card.workspaceStatusId))) &&
      (filters.reviewStates.length === 0 ||
        (reviewState !== null && filters.reviewStates.includes(reviewState)))
    )
  })
}

export function filterDashboardWorkspaces(
  workspaces: DashboardWorkspace[],
  query: string,
  filters: DashboardFilters
): DashboardWorkspace[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return workspaces.filter((workspace) =>
    workspaceMatchesFilters(workspace, normalizedQuery, filters)
  )
}

export function toggleDashboardFilter<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value]
}
