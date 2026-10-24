import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { AGENT_SESSION_CLAUDE_ACCOUNT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { isLaunchConfigClaudeAccountId } from '../../../shared/claude/project-claude-account-preference'
import { createAgentSessionKeyboardOptions } from './agent-session-keyboard-capability'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

type AgentSessionLaunchOptions = { terminalKittyKeyboardProtocol?: true; claudeAccountId?: string }

/**
 * Negotiated agent-session params. The launch config's Claude account is sent only to hosts that
 * advertise it: older hosts parse these params strictly and would refuse the whole launch.
 */
export function createAgentSessionLaunchOptions(keyboardProtocol: boolean | undefined) {
  const keyboardOptions = createAgentSessionKeyboardOptions(keyboardProtocol)
  let claudeAccountSupported: Promise<boolean> | undefined
  return async (
    environmentId: string,
    launchConfig: Pick<SleepingAgentLaunchConfig, 'claudeAccountId'> | undefined
  ): Promise<AgentSessionLaunchOptions> => {
    const keyboard = await keyboardOptions(environmentId)
    const claudeAccountId = launchConfig?.claudeAccountId
    if (!isLaunchConfigClaudeAccountId(claudeAccountId)) {
      return keyboard
    }
    // Why: a replay under one operation id must keep its original payload even after a host upgrade.
    claudeAccountSupported ??= runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_CLAUDE_ACCOUNT_RUNTIME_CAPABILITY
    ).catch((error: unknown) => {
      if (isRuntimeCompatBlockError(error)) {
        throw error
      }
      return false
    })
    return (await claudeAccountSupported) ? { ...keyboard, claudeAccountId } : keyboard
  }
}
