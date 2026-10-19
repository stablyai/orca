import type { ComputerAwakeMode } from './computer-awake-mode'

/** Settings for what Orca does on this computer while agents run. */
export type AgentActivityGlobalSettings = {
  /** When true, Orca requests local awake assertions while hook-reported agents are working. */
  keepComputerAwakeWhileAgentsRun: boolean
  /** Optional for mixed-version compatibility; the legacy boolean maps true to Auto. */
  computerAwakeMode?: ComputerAwakeMode
  /** Publish agent activity counts to the local Discord client as Rich Presence. Absent reads as off. */
  discordPresenceEnabled?: boolean
}
