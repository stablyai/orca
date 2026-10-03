export type BacklogItemKind = 'pr' | 'issue' | 'branch' | 'task'

export type BacklogItemStatus = 'todo' | 'in_progress' | 'completed'

export type AssignedAgentInfo = {
  index: number
  label: string
  terminalHandle?: string
}

export type BacklogItem = {
  id: string
  kind: BacklogItemKind
  title: string
  number?: number
  ref?: string
  url?: string
  status: BacklogItemStatus
  assignedAgent?: AssignedAgentInfo
  labels?: string[]
  author?: string
  updatedAt?: number
}

export type BacklogCategoryFilter = 'all' | 'pr' | 'issue' | 'branch'

export type BacklogStatusFilter = 'all' | 'todo' | 'in_progress' | 'completed'

export type BacklogViewMode = 'checklist' | 'kanban'
