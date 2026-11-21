// orca-fork: agent teams. A bot the owner lets build a team creates bots from its own offers (no Create
// press), and they share one bot group with it.
import * as z from 'zod'

export const AGENT_TEAMS_GET_METHOD = 'orcaFork.teams.get'
export const AGENT_TEAMS_SET_METHOD = 'orcaFork.teams.set'

export const TEAM_DAILY_CAP_DEFAULT = 5
export const TEAM_DAILY_CAP_MAX = 20

export const AgentTeamSettingsSchema = z.object({
  teamBuilder: z.boolean(),
  dailyCap: z.number().int().min(1).max(TEAM_DAILY_CAP_MAX)
})
export type AgentTeamSettings = z.infer<typeof AgentTeamSettingsSchema>

export const AgentTeamsGet = z.object({ botId: z.string().min(1) })
export const AgentTeamsSet = AgentTeamsGet.extend({
  teamBuilder: z.boolean(),
  dailyCap: AgentTeamSettingsSchema.shape.dailyCap.optional()
})

export type AgentTeamView = AgentTeamSettings & {
  /** Bots created from its offers in the last 24 hours. */
  createdToday: number
  /** Its team's bot group, once it has one. */
  groupId: string | null
}

/** The team room's name, within the 64-character bot name limit. */
export function teamGroupName(leadName: string): string {
  const suffix = '’s team'
  return `${leadName.slice(0, 64 - suffix.length)}${suffix}`
}

/** Created timestamps still inside the cap's 24-hour window. */
export function createdInLastDay(created: readonly number[], now: number): number[] {
  return created.filter((at) => now - at < 24 * 60 * 60 * 1000)
}
