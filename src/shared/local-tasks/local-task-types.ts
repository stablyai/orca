export type LocalTaskStatusCategory = 'todo' | 'in-progress' | 'blocked' | 'done'

export type LocalTask = {
  id: string
  title: string
  status: string
  statusCategory: LocalTaskStatusCategory
  labels: string[]
  url: string | null
  /** Ids of tasks that must finish first (`depends_on`). */
  dependsOn: string[]
  /** 1 (highest) to 5; 3 when unset (`priority`, `p1` also accepted). */
  priority: number
  /** Who holds the task (`claimed_by`) and since when (`claimed_at`); see local-task-scheduling. */
  claimedBy: string | null
  claimedAt: string | null
  blockedReason: string | null
  updatedAt: string | null
  filePath: string
  fields: Record<string, string>
}

export type LocalTaskListResult = {
  folder: string
  tasks: LocalTask[]
}
