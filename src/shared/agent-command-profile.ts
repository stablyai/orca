import type { TuiAgent } from './tui-agent'

/** A named, user-defined launch command for an agent that already has a
 *  default (via the catalog or `agentCmdOverrides`). Lets the same agent
 *  (e.g. `claude`) be launched under multiple CLI commands/wrappers — for
 *  example separate accounts or environments — without introducing a new
 *  `TuiAgent` id. */
export type AgentCommandProfile = {
  id: string
  label: string
  cmd: string
}

/** Folds a selected command profile's `cmd` into `cmdOverrides` for `agent`,
 *  so callers can keep using the existing single-override launch path
 *  unchanged. Falls back to `cmdOverrides` as-is when no profile matches. */
export function applyAgentCommandProfile(
  cmdOverrides: Partial<Record<TuiAgent, string>>,
  agent: TuiAgent | null,
  profileId: string | null | undefined,
  profiles: readonly AgentCommandProfile[] | undefined
): Partial<Record<TuiAgent, string>> {
  if (!agent || !profileId) {
    return cmdOverrides
  }
  const profile = profiles?.find((candidate) => candidate.id === profileId)
  return profile?.cmd ? { ...cmdOverrides, [agent]: profile.cmd } : cmdOverrides
}
