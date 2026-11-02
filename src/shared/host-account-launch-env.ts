/**
 * The account env a desktop pushes to a host it owns the accounts of (a WSL distro's orcad, which
 * has no account services: WSL-via-orcad D10). Launches the host starts on its own (CLI,
 * orchestration, automations, structured chats, AI commit text, bare commands) take it, so they run
 * the account this desktop selected for that distro, as its own launches into the distro do.
 */
import { z } from 'zod'
import { AgentLaunchAccountEnv } from './agent-launch-account-env'

export const HostAccountLaunchEnvParams = z
  .object({
    /** The distro whose accounts these are; names the owner in this host's messages. */
    wslDistro: z.string().trim().min(1).max(256),
    /** For a `claude` the host starts directly: the selected account's CLAUDE_CONFIG_DIR. */
    claude: AgentLaunchAccountEnv,
    /** For every other process: the pointer a typed `claude` follows, plus CODEX_HOME. */
    terminal: AgentLaunchAccountEnv
  })
  .strict()

export type HostAccountLaunchEnv = z.infer<typeof HostAccountLaunchEnvParams>

/** The env a process for `agent` takes; `null` is a plain shell. */
export function hostAccountLaunchEnvFor(
  launchEnv: HostAccountLaunchEnv | null,
  agent: string | null | undefined
): Readonly<Record<string, string>> {
  if (!launchEnv) {
    return {}
  }
  return agent === 'claude' ? launchEnv.claude : launchEnv.terminal
}

export function hostAccountsManagedByDesktopMessage(wslDistro: string): string {
  return `Accounts for this WSL host are managed in the Orca desktop app: Settings → AI Provider Accounts, with the ${wslDistro} (WSL) host selected.`
}
