export type WorkLogProvider =
  | 'activity'
  | 'github'
  | 'gitlab'
  | 'linear'
  | 'jira'
  | 'azure-devops'
  | 'ninjaone'
  | 'planner'

export type WorkLogEntry = {
  id: string
  startAt: number
  endAt: number
  title: string
  provider: WorkLogProvider
  reference: string | null
  notes: string | null
  badgeDerived: boolean
}
