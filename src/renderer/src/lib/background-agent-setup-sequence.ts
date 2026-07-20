import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { launchWorktreeBackgroundTerminals } from '@/lib/launch-worktree-background-terminals'
import {
  createSequencedSetupAgentCommands,
  DEFAULT_SETUP_AGENT_SEQUENCE_WAIT_TIMEOUT_SECONDS
} from '../../../shared/setup-agent-sequencing'
import { getSetupRunnerCommandPlatformForPath } from '../../../shared/setup-runner-command'
import type { WorktreeDefaultTabsLaunch, WorktreeSetupLaunch } from '../../../shared/types'

export const SETUP_GATED_AGENT_READY_TIMEOUT_MS =
  (DEFAULT_SETUP_AGENT_SEQUENCE_WAIT_TIMEOUT_SECONDS + 10) * 1000

export type PreAgentWorktreeSetup = {
  setup: WorktreeSetupLaunch
  defaultTabs?: WorktreeDefaultTabsLaunch
}

export async function sequenceBackgroundAgentStartupAfterSetup(
  worktreeId: string,
  initialStartupPlan: AgentStartupPlan,
  launchPlatform: NodeJS.Platform,
  preAgentWorktreeSetup: PreAgentWorktreeSetup
): Promise<AgentStartupPlan> {
  const { setup } = preAgentWorktreeSetup
  const sequenced = createSequencedSetupAgentCommands({
    runnerScriptPath: setup.runnerScriptPath,
    startupCommand: initialStartupPlan.launchCommand,
    platform: getSetupRunnerCommandPlatformForPath(
      setup.runnerScriptPath,
      launchPlatform === 'win32' ? 'windows' : 'posix'
    )
  })
  const startupPlan = {
    ...initialStartupPlan,
    launchCommand: sequenced.startupCommand,
    env: { ...initialStartupPlan.env, ...sequenced.startupEnv }
  }

  // Why: setup-created config and skills must exist before the unattended agent
  // starts; the shared marker gate preserves that order across local, SSH, and runtime hosts.
  await launchWorktreeBackgroundTerminals({
    worktreeId,
    setup: { ...setup, command: sequenced.setupCommand },
    defaultTabs: preAgentWorktreeSetup.defaultTabs
  })
  return startupPlan
}
