import type { SecretAtRestProtection } from '../secure-storage/secret-at-rest-protection'

export type ItsaplanStateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export type ItsaplanFailureCode =
  | 'notConnected'
  | 'invalidUrl'
  | 'apiNotFound'
  | 'invalidApiKey'
  | 'forbidden'
  | 'unreachable'
  | 'notFound'
  | 'rateLimited'
  | 'requestFailed'

export type ItsaplanFailure = { ok: false; error: ItsaplanFailureCode; message: string }

export type ItsaplanResult<T extends object> = ({ ok: true } & T) | ItsaplanFailure

export type ItsaplanViewer = {
  id: string
  name: string
  email: string | null
}

export type ItsaplanInstance = {
  id: string
  appUrl: string
  apiUrl: string
}

export type ItsaplanConnectionStatus = {
  connected: boolean
  viewer: ItsaplanViewer | null
  instance: ItsaplanInstance | null
  credentialError?: string
  credentialProtection?: SecretAtRestProtection | null
}

export type ItsaplanProject = {
  id: number
  ref: string
  key: string
  name: string
}

export type ItsaplanColumn = {
  id: number
  name: string
  stateType: ItsaplanStateType
  position: number
}

export type ItsaplanLabel = {
  id: number
  name: string
  color: string | null
}

export type ItsaplanMember = {
  userId: string
  name: string
  isAgent: boolean
}

export type ItsaplanProjectMetadata = {
  project: ItsaplanProject
  columns: ItsaplanColumn[]
  labels: ItsaplanLabel[]
  members: ItsaplanMember[]
}

export type ItsaplanIssueState = {
  columnId: number
  name: string
  stateType: ItsaplanStateType
}

export type ItsaplanIssue = {
  id: number
  identifier: string
  sequenceNumber: number
  projectRef: string
  title: string
  description: string
  priority: string | null
  state: ItsaplanIssueState
  labels: ItsaplanLabel[]
  assignee: ItsaplanMember | null
  delegate: ItsaplanMember | null
  parentId: number | null
  url: string
  createdAt: string
  updatedAt: string
}

export type ItsaplanComment = {
  id: number
  body: string
  author: { userId: string; name: string } | null
  createdAt: string
}

export type ItsaplanIssueDetail = ItsaplanIssue & {
  subtasks: ItsaplanIssue[]
  comments: ItsaplanComment[]
}

export type ItsaplanIssueListFilters = {
  stateTypes?: ItsaplanStateType[]
  assignee?: 'me' | 'unassigned' | { userId: string }
  labelIds?: number[]
}

export type ItsaplanIssueListQuery = {
  projectRef: string
  filters: ItsaplanIssueListFilters
  search?: string
  limit?: number
}

export type ItsaplanCreateIssueArgs = {
  projectRef: string
  title: string
  description?: string
  columnId?: number
  priority?: string | null
  labelIds?: number[]
  assigneeUserId?: string | null
  parentId?: number | null
}

export type ItsaplanIssueUpdate = {
  title?: string
  description?: string
  columnId?: number
  priority?: string | null
  labelIds?: number[]
  assigneeUserId?: string | null
}

export const ITSAPLAN_LIST_LIMIT_MAX = 500

export function itsaplanIssueWebUrl(appUrl: string, issueId: number): string {
  return `${appUrl}/issue/${issueId}`
}
