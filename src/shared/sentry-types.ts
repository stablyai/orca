export type SentryOrganization = {
  id: string
  slug: string
  name: string
}

export type SentryConnection = {
  baseUrl: string
  organization: SentryOrganization
}

export type SentryConnectionStatus = {
  connected: boolean
  connection: SentryConnection | null
  organizations: SentryOrganization[]
  credentialError?: string
}

export type SentryProject = {
  id: string
  slug: string
  name: string
  platform?: string | null
}

export type SentryEnvironment = {
  id: string
  name: string
}

export type SentryAssignee = {
  type: 'user' | 'team'
  id: string
  name: string
  email?: string | null
}

export type SentryIssuePriority = 'low' | 'medium' | 'high'
export type SentryIssueStatus = string

export type SentryIssue = {
  id: string
  shortId: string
  title: string
  culprit: string
  permalink: string
  project: SentryProject
  status: SentryIssueStatus
  substatus?: string | null
  level: string
  priority?: SentryIssuePriority | null
  assignedTo?: SentryAssignee | null
  count: number
  userCount: number
  firstSeen: string
  lastSeen: string
  platform?: string | null
  issueCategory?: string | null
  metadata: Record<string, unknown>
  tags?: { key: string; name: string; totalValues?: number }[]
  latestEvent?: SentryEvent | null
}

export type SentryStackFrame = {
  filename?: string | null
  function?: string | null
  module?: string | null
  lineNo?: number | null
  columnNo?: number | null
  contextLine?: string | null
  inApp?: boolean | null
}

export type SentryException = {
  type?: string | null
  value?: string | null
  module?: string | null
  frames: SentryStackFrame[]
}

export type SentryBreadcrumb = {
  timestamp?: string | null
  category?: string | null
  type?: string | null
  level?: string | null
  message?: string | null
  data?: Record<string, unknown> | null
}

export type SentryEvent = {
  id: string
  eventId: string
  title: string
  dateCreated: string
  environment?: string | null
  release?: string | null
  platform?: string | null
  message?: string | null
  exceptions: SentryException[]
  breadcrumbs: SentryBreadcrumb[]
  tags: { key: string; value: string }[]
  contexts: Record<string, unknown>
  request?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
}

export type SentryPage<T> = {
  items: T[]
  nextCursor: string | null
  previousCursor: string | null
}

export type SentryIssueQuery = {
  query?: string
  projects?: string[]
  environments?: string[]
  statsPeriod?: string
  sort?: 'date' | 'freq' | 'inbox' | 'new' | 'recommended' | 'trends' | 'user'
  cursor?: string
  limit?: number
}

export type SentryIssueUpdate = {
  status?: 'resolved' | 'unresolved' | 'ignored'
  priority?: SentryIssuePriority
  assignedTo?: string | null
}

export type SentryMutationResult = { ok: true; issue: SentryIssue } | { ok: false; error: string }
