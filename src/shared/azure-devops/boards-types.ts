export type AzureDevOpsTeam = { id: string; name: string; isDefault: boolean }

export type AzureDevOpsIterationTimeFrame = 'past' | 'current' | 'future'

export type AzureDevOpsIteration = {
  id: string
  name: string
  path: string
  timeFrame: AzureDevOpsIterationTimeFrame | null
  startDate: string | null
  finishDate: string | null
}

export type AzureDevOpsBugsBehavior = 'asRequirements' | 'asTasks' | 'off'

export type AzureDevOpsBacklogColumnField = {
  referenceName: string
  name: string
  width: number
}

export type AzureDevOpsBacklogLevel = {
  /** Category id, e.g. `Microsoft.RequirementCategory`. */
  id: string
  name: string
  rank: number
  kind: 'portfolio' | 'requirement' | 'task'
  workItemTypes: string[]
  columnFields: AzureDevOpsBacklogColumnField[]
  hidden: boolean
}

export type AzureDevOpsBacklogConfiguration = {
  levels: AzureDevOpsBacklogLevel[]
  bugsBehavior: AzureDevOpsBugsBehavior
}

export type AzureDevOpsStateCategory =
  | 'Proposed'
  | 'InProgress'
  | 'Resolved'
  | 'Completed'
  | 'Removed'

export type AzureDevOpsWorkItemTypeMetadata = {
  name: string
  color: string | null
  iconId: string | null
  /** Hosted ADO serves this SVG anonymously; on-prem may not, so renderers need a fallback. */
  iconUrl: string | null
  states: { name: string; color: string | null; category: AzureDevOpsStateCategory }[]
}

export type AzureDevOpsIdentityRef = {
  displayName: string
  uniqueName: string | null
  imageUrl: string | null
}

export type AzureDevOpsWorkItem = {
  id: number
  rev: number
  workItemType: string
  title: string
  state: string
  assignedTo: AzureDevOpsIdentityRef | null
  areaPath: string
  iterationPath: string
  tags: string[]
  parentId: number | null
  stackRank: number | null
  url: string
  /** Every hydrated field by reference name, for column rendering. */
  fields: Record<string, unknown>
}

export type AzureDevOpsWorkItemDetail = AzureDevOpsWorkItem & {
  descriptionHtml: string | null
  acceptanceCriteriaHtml: string | null
  childIds: number[]
  pullRequestLinks: { id: number; url: string }[]
  createdDate: string | null
  changedDate: string | null
}

export type AzureDevOpsBacklogPage = {
  level: AzureDevOpsBacklogLevel
  /** Level items in stack-rank order. */
  items: AzureDevOpsWorkItem[]
  /** One level down, keyed by parent id, in stack-rank order. */
  childrenByParent: Record<number, number[]>
  /** Items referenced by `childrenByParent` values. */
  children: AzureDevOpsWorkItem[]
  /** Parent-level items referenced by `items[].parentId`, for Show parents. */
  parents: AzureDevOpsWorkItem[]
  /**
   * Parents referenced by `children[].parentId` / `parents[].parentId` that are on
   * no other list (e.g. hidden-level grandparents), for the Parent column and the
   * detail dialog. Absent from older hosts.
   */
  ancestors?: AzureDevOpsWorkItem[]
}

export type AzureDevOpsBoardColumn = {
  id: string
  name: string
  columnType: 'incoming' | 'inProgress' | 'outgoing'
  itemLimit: number
  isSplit: boolean
  stateMappings: Record<string, string>
  description: string | null
}

export type AzureDevOpsBoardRow = {
  id: string
  name: string
  color: string | null
  isDefault: boolean
}

export type AzureDevOpsBoardCardField = { referenceName: string; core: boolean }

export type AzureDevOpsBoardConfiguration = {
  id: string
  name: string
  columns: AzureDevOpsBoardColumn[]
  rows: AzureDevOpsBoardRow[]
  columnField: string
  rowField: string
  doneField: string
  cardFields: Record<string, { fields: AzureDevOpsBoardCardField[]; showEmptyFields: boolean }>
  tagColors: Record<string, string>
}

export type AzureDevOpsBoardSummary = { id: string; name: string }

/** A saved backlog filter as the signed-in user left it in ADO; plain arrays so it crosses IPC. */
export type AzureDevOpsBacklogSavedFilter = {
  keyword: string | null
  workItemTypes: string[]
  /** Display names: ADO stores the identity's display text, not its unique name. */
  assignedTo: string[]
  states: string[]
  areaPaths: string[]
  iterationPaths: string[]
  tags: string[]
}

/**
 * The signed-in user's own Backlogs hub settings for one team. Every part is
 * optional at the source (a fresh user has none), so consumers fall back to
 * process defaults per field.
 */
export type AzureDevOpsBacklogViewSettings = {
  /** Column options per level id; rollup columns are dropped (not rendered yet). */
  columnOptionsByLevel: Record<string, AzureDevOpsBacklogColumnField[]>
  showParents: boolean | null
  /** ADO's "In progress items" view option; `false` hides InProgress-category items. */
  inProgressFilter: boolean | null
  savedFiltersByLevel: Record<string, AzureDevOpsBacklogSavedFilter>
}

/** Everything the renderer needs once a team is chosen; returned by one IPC call. */
export type AzureDevOpsTeamConfiguration = {
  backlog: AzureDevOpsBacklogConfiguration | null
  iterations: AzureDevOpsIteration[]
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
  repo: { organization: string | null; project: string }
  /** Absent from older hosts and when the per-user settings call fails. */
  viewSettings?: AzureDevOpsBacklogViewSettings | null
}
