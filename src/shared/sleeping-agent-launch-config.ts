import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import { AUTOMATION_RUN_ENV_KEYS } from './automation-run-env'

/**
 * Why dropped rather than carried: a resume is a fresh, user-initiated launch of the
 * same agent, and it would otherwise re-spawn holding the seeding run's identity --
 * making `ORCA_AUTOMATION_ID` present on a launch that is not an automation run. The
 * automation's own pane is unaffected; its env is built separately from this record.
 */
function withoutAutomationRunIdentity(env: Record<string, string>): Record<string, string> {
  const durable = { ...env }
  for (const key of AUTOMATION_RUN_ENV_KEYS) {
    delete durable[key]
  }
  return durable
}

export function buildSleepingAgentLaunchConfig(args: {
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Why: startup env may include prompt transport or pane identity values;
    // durable resume state is limited to Orca-managed agent inputs.
    agentEnv: args.agentEnv ? withoutAutomationRunIdentity(args.agentEnv) : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {})
  }
}
