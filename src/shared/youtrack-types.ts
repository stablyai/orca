import type { SecretAtRestProtection } from './secret-at-rest-protection'

export type YouTrackUser = {
  id: string
  login: string
  fullName: string
  email?: string | null
  avatarUrl?: string
}

export type YouTrackConnectionStatus = {
  connected: boolean
  baseUrl: string | null
  viewer: YouTrackUser | null
  /** TLS certificate verification is skipped for this host. */
  allowInsecureTls?: boolean
  credentialError?: string
  credentialProtection?: SecretAtRestProtection | null
}

export type YouTrackColor = {
  background: string | null
  foreground: string | null
}

export type YouTrackProject = {
  id: string
  shortName: string
  name: string
}

export type YouTrackState = {
  name: string
  isResolved: boolean
  color?: YouTrackColor | null
}

/** A custom field rendered as plain text; state/assignee are also lifted onto the issue. */
export type YouTrackFieldValue = {
  name: string
  /** Display text. */
  value: string | null
  /** Option names / user logins, or the plain text an input edits. */
  raw: string[]
}

export type YouTrackTag = {
  name: string
  color?: YouTrackColor | null
}

export type YouTrackLinkedIssue = {
  id: string
  idReadable: string
  summary: string
  resolved: boolean
  state: string | null
}

export type YouTrackLinkGroup = {
  /** Link verb as YouTrack phrases it from this issue, e.g. "depends on". */
  label: string
  linkTypeName: string
  /** Issues in this group block the current one. */
  blocking: 'blocked-by' | 'blocks' | null
  issues: YouTrackLinkedIssue[]
}

export type YouTrackIssue = {
  id: string
  idReadable: string
  summary: string
  description?: string
  url: string
  project: YouTrackProject
  state: YouTrackState | null
  /** Name of the custom field holding the state, needed to change it. */
  stateFieldName: string | null
  assignee: YouTrackUser | null
  reporter: YouTrackUser | null
  priority: string | null
  type: string | null
  fields: YouTrackFieldValue[]
  tags: YouTrackTag[]
  links: YouTrackLinkGroup[]
  /** Unresolved issues this one depends on. */
  unresolvedBlockerCount: number
  resolved: boolean
  createdAt: string
  updatedAt: string
}

export type YouTrackComment = {
  id: string
  text: string
  createdAt: string
  updatedAt?: string
  author?: YouTrackUser
}

/** A state the issue can move to: a value for plain state fields, an event for state machines. */
export type YouTrackStateOption = {
  id: string
  label: string
  kind: 'value' | 'event'
  isResolved?: boolean
  current?: boolean
}

/** Cap for a comment or description written through Orca. */
export const YOUTRACK_BODY_MAX_CHARS = 100_000

export const YOUTRACK_ISSUE_PRESETS = ['assigned', 'reported', 'open', 'done'] as const
export type YouTrackIssuePreset = (typeof YOUTRACK_ISSUE_PRESETS)[number]

export type YouTrackConnectArgs = {
  baseUrl: string
  token: string
  allowInsecureTls?: boolean
}

export type YouTrackConnectResult =
  | { ok: true; viewer: YouTrackUser }
  | { ok: false; error: string }

export type YouTrackListIssuesArgs = {
  preset?: YouTrackIssuePreset
  query?: string
  limit?: number
}

export type YouTrackListIssuesResult =
  | { ok: true; issues: YouTrackIssue[] }
  | { ok: false; error: string }

export type YouTrackIssueResult = { ok: true; issue: YouTrackIssue } | { ok: false; error: string }

export type YouTrackCommentsResult =
  | { ok: true; comments: YouTrackComment[] }
  | { ok: false; error: string }

export type YouTrackStateOptionsResult =
  | { ok: true; options: YouTrackStateOption[] }
  | { ok: false; error: string }

export type YouTrackAddCommentResult =
  | { ok: true; comment: YouTrackComment }
  | { ok: false; error: string }

export type YouTrackSetStateArgs = {
  idReadable: string
  option: YouTrackStateOption
}

export type YouTrackProjectSummary = {
  id: string
  shortName: string
  name: string
}

export type YouTrackProjectsResult =
  | { ok: true; projects: YouTrackProjectSummary[] }
  | { ok: false; error: string }

/** How a field is edited: pick from options, or type a value. */
export type YouTrackFieldKind =
  | 'enum'
  | 'user'
  | 'version'
  | 'build'
  | 'owned'
  | 'state'
  | 'string'
  | 'integer'
  | 'float'
  | 'date'
  | 'datetime'
  | 'period'
  | 'text'
  | 'unknown'

export type YouTrackFieldOption = {
  /** Value sent back on write: the option name, or a user's login. */
  value: string
  label: string
}

export type YouTrackFieldSchema = {
  name: string
  kind: YouTrackFieldKind
  multi: boolean
  required: boolean
  /** Text YouTrack shows for an empty value, e.g. "Unassigned". */
  emptyText: string | null
  options: YouTrackFieldOption[]
  /** Raw values YouTrack fills in when the field is omitted on create. */
  defaults: string[]
}

export type YouTrackProjectFieldsResult =
  | { ok: true; fields: YouTrackFieldSchema[] }
  | { ok: false; error: string }

/** A field write: option values / logins, or one typed string; empty clears the field. */
export type YouTrackFieldInput = {
  name: string
  values: string[]
}

export type YouTrackUpdateFieldArgs = {
  idReadable: string
  projectId: string
  field: YouTrackFieldInput
}

export type YouTrackCreateIssueArgs = {
  projectId: string
  summary: string
  description?: string
  fields: YouTrackFieldInput[]
}
