import type { LinearTeamSummary } from './agent-result-types'

export type LinearCycleSummary = {
  id: string
  number: number
  name: string | null
  description: string | null
  startsAt: string
  endsAt: string
  isActive: boolean
  isFuture: boolean
  isPast: boolean
}

export type LinearTeamCyclesResult = {
  team: LinearTeamSummary
  cycles: LinearCycleSummary[]
  meta: { workspaceId: string; returned: number; currentOnly: boolean }
}
