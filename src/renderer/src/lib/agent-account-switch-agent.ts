/**
 * What one agent supplies to the shared account-switch flow. Adding an agent also needs its
 * AccountRestartAgent id, a listing in agent-account-switch-agents.ts, and its setting key and copy.
 */
import type { AppState } from '@/store'
import type { AgentAccountSwitchSettings } from '../../../shared/agent-account-switch-settings'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { AgentAccountRestartStartup } from './agent-account-restart-startup'

/** A selected account row and the roster it was selected from. */
export type AgentAccountSnapshot = {
  state: {
    accounts: readonly {
      id: string
      email: string
      workspaceLabel?: string | null
      runsOnSystemDefault?: boolean
    }[]
  }
  accountId: string | null | undefined
}

/** What the pane's process inspection reports. */
export type AgentForegroundReading = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
}

export type AccountSwitchAgent = {
  agent: AccountRestartAgent
  settingKey: keyof AgentAccountSwitchSettings
  /** Relaunch for a session with nothing to resume; without one, only resumable sessions count. */
  freshStartup?: AgentAccountRestartStartup
  /**
   * Account id, null for System default, undefined when the transcript cannot tell. `owner` is
   * the host whose roster the switch wrote, since a server's homes are not this machine's.
   */
  transcriptAccountId: (
    transcriptPath: string | undefined,
    context: { state: AppState; owner: RuntimeClientTarget }
  ) => string | null | undefined
  /** The account id a session launched under `snapshot` reports in its transcript. */
  launchAccountId: (snapshot: AgentAccountSnapshot) => string | null
  accountLabel: (snapshot: AgentAccountSnapshot) => string
  /** Whether this reading shows the agent, not a shell, holding the pane. */
  isAgentForeground: (reading: AgentForegroundReading, launchAgent: TuiAgent | undefined) => boolean
  copy: {
    /** `previous`, `next` and `count` are interpolated. */
    body: (values: { count: number; previous: string; next: string }) => string
    settingTitle: () => string
    settingDescription: () => string
  }
}
