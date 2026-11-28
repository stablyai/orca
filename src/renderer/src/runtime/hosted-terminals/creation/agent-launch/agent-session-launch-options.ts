import type { SleepingAgentLaunchConfig } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { AGENT_SESSION_CLAUDE_ACCOUNT_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { isLaunchConfigClaudeAccountId } from '../../../../../../shared/claude/project-claude-account-preference'
import type { TerminalOscColorQueryReplyColors } from '../../../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import { createAgentSessionTerminalOptions } from './agent-session-terminal-options'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { isRuntimeCompatBlockError } from '@/runtime/rpc/compatibility/runtime-protocol-compat'

type AgentSessionLaunchOptions = Awaited<
  ReturnType<ReturnType<typeof createAgentSessionTerminalOptions>>
> & { claudeAccountId?: string }

/**
 * Negotiated agent-session params. The launch config's Claude account is sent only to hosts that
 * advertise it: older hosts parse these params strictly and would refuse the whole launch.
 */
export function createAgentSessionLaunchOptions(
  keyboardProtocol: boolean | undefined,
  colors: TerminalOscColorQueryReplyColors | undefined
) {
  const terminalOptions = createAgentSessionTerminalOptions(keyboardProtocol, colors)
  let claudeAccountSupported: Promise<boolean> | undefined
  return async (
    environmentId: string,
    launchConfig: Pick<SleepingAgentLaunchConfig, 'claudeAccountId'> | undefined
  ): Promise<AgentSessionLaunchOptions> => {
    const terminal = await terminalOptions(environmentId)
    const claudeAccountId = launchConfig?.claudeAccountId
    if (!isLaunchConfigClaudeAccountId(claudeAccountId)) {
      return terminal
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
    return (await claudeAccountSupported) ? { ...terminal, claudeAccountId } : terminal
  }
}
