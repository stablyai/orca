import type { WorkspaceStatusDefinition } from './types'

export const DEFAULT_STATUS_VISUALS: Record<string, { color: string; icon: string }> = {
  todo: { color: 'neutral', icon: 'circle' },
  'in-progress': { color: 'conductor-progress', icon: 'conductor-progress' },
  'in-review': { color: 'conductor-review', icon: 'conductor-review' },
  completed: { color: 'conductor-done', icon: 'conductor-done' }
}

export const DEFAULT_WORKSPACE_STATUSES = [
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
  {
    id: 'in-progress',
    label: 'In progress',
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  { id: 'in-review', label: 'In review', color: 'conductor-review', icon: 'conductor-review' },
  { id: 'completed', label: 'Done', color: 'conductor-done', icon: 'conductor-done' }
] as const satisfies readonly WorkspaceStatusDefinition[]
