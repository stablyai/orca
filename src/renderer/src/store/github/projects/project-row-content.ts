export type ProjectRowContentUpdate = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type ProjectRowContentPatch = {
  title?: string
  body?: string
  state?: 'open' | 'closed' | 'merged' | 'draft'
  labels?: string[]
  assignees?: string[]
}
