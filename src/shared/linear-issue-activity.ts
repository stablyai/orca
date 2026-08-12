import type { LinearNamedEntity, LinearUserSummary } from './linear-agent-result-types'

export type LinearIssueActivityActor = LinearUserSummary & {
  kind: 'user' | 'bot' | 'system'
  name?: string | null
  type?: string | null
  subType?: string | null
}

export type LinearIssueActivityEntity = LinearNamedEntity & {
  identifier?: string | null
  title?: string | null
  url?: string | null
}

export type LinearIssueActivityValue =
  | string
  | number
  | boolean
  | LinearIssueActivityEntity
  | LinearIssueActivityEntity[]
  | null

export type LinearIssueActivityChange = {
  field: string
  from?: LinearIssueActivityValue
  to?: LinearIssueActivityValue
}

export type LinearIssueActivityEntry = {
  id: string
  createdAt?: string | null
  updatedAt?: string | null
  actor: LinearIssueActivityActor
  changes: LinearIssueActivityChange[]
}
