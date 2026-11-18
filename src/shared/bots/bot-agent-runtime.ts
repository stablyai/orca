// Bots on these agents run only on Orca's own managed runtime: its pinned version is the one
// checked to take a bot's standing instructions, so a host without it cannot run them.
import { formatAgentTypeLabel } from '../agent-status/presentation/agent-type-label'

const BOT_AGENTS_ON_MANAGED_RUNTIME: ReadonlySet<string> = new Set(['antigravity'])

export function botAgentNeedsManagedRuntime(agent: string): boolean {
  return BOT_AGENTS_ON_MANAGED_RUNTIME.has(agent)
}

/** Why a bot can't run on `agent` on a host, or null when it can. `hostHasManagedRuntime` is what
 *  the host publishes as the agent's `managedRuntime`, which its own pin decides. */
export function botAgentHostRefusal(agent: string, hostHasManagedRuntime: boolean): string | null {
  if (!botAgentNeedsManagedRuntime(agent) || hostHasManagedRuntime) {
    return null
  }
  const label = formatAgentTypeLabel(agent)
  return `${label} bots need Orca's own ${label} server, which isn't available on the computer this bot runs on.`
}
