export type ExternalTaskProvider = 'azure-devops' | 'planner' | 'ninjaone'

export type ExternalTaskProviderStatus = {
  provider: ExternalTaskProvider
  configured: boolean
  authenticated: boolean
  account: string | null
  error?: string
}

export type ExternalTask = {
  provider: ExternalTaskProvider
  id: string
  identifier: string
  title: string
  status: string
  assignee: string | null
  assigneeId?: string | null
  updatedAt: string | null
  url: string
  description?: string
  priority?: string
  severity?: string
}

export type ExternalTaskActivity = {
  id: string
  title?: string
  body: string
  kind?: string
  author?: string | null
  createdAt: string | null
  isPublic?: boolean
}

export type ExternalTaskChecklistItem = {
  id: string
  title: string
  completed: boolean
}

export type ExternalTaskReference = {
  id: string
  title: string
  url?: string
  subtitle?: string
}

export type ExternalTaskDetailSection = {
  id: string
  title: string
  fields: {
    label: string
    value: string | null
  }[]
}

export type ExternalTaskDetail = ExternalTask & {
  type?: string
  form?: string
  requester?: string
  organization?: string
  location?: string
  device?: string
  createdAt?: string | null
  dueAt?: string | null
  completedAt?: string | null
  tags?: string[]
  detailSections?: ExternalTaskDetailSection[]
  activity?: ExternalTaskActivity[]
  checklist?: ExternalTaskChecklistItem[]
  references?: ExternalTaskReference[]
}

export type ExternalTaskListArgs = {
  provider: ExternalTaskProvider
  query?: string
  limit?: number
}

export type ExternalTaskDetailArgs = {
  provider: ExternalTaskProvider
  id: string
}

export type ExternalTaskUpdateArgs = ExternalTaskDetailArgs & {
  title?: string
  status?: string
  assignee?: string | null
  description?: string
  comment?: string
  priority?: string
  severity?: string
}

export type ExternalTaskSelectOption = {
  value: string
  label: string
}

export type ExternalTaskEditOptions = {
  statuses: ExternalTaskSelectOption[]
  assignees: ExternalTaskSelectOption[]
  priorities: ExternalTaskSelectOption[]
  severities: ExternalTaskSelectOption[]
}
