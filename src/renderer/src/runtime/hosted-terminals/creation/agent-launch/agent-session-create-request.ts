import type { TerminalOptionEdits } from '../../../../../../shared/agent-launch/choices/agent-launch-choices'
import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import {
  AGENT_SESSION_TRUST_WORKTREE_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery
} from '../../../../../../shared/agent-session/agent-session-host-authority'
import type { SessionOptionValue } from '../../../../../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  runtimeEnvironmentSupportsCapability,
  runtimeEnvironmentSupportsCapabilities
} from '../../../rpc/compatibility/runtime-capability-proof'
import { toRuntimeWorktreeSelector } from '../../../rpc/targets/runtime-worktree-selector'

export async function agentSessionCreateCapabilities(environmentId: string) {
  const [complete, choices] = await runtimeEnvironmentSupportsCapabilities(environmentId, [
    AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_CHOICES_CAPABILITY
  ])
  return { complete, capable: complete || choices }
}

export function agentSessionCreateRequest(args: {
  worktreeId: string
  agent: TuiAgent
  agentArgs?: string | null
  terminalOptionEdits?: TerminalOptionEdits
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  extraAgentArgs?: string
  prompt?: string
  promptDelivery?: AgentPromptDelivery
  launchPreferences?: AgentLaunchPreferences
}) {
  return {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    agent: args.agent,
    ...(args.terminalOptionEdits?.effort === null
      ? { terminalOptionEdits: args.terminalOptionEdits }
      : {}),
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.sessionOptions !== undefined
      ? {
          sessionOptions: Object.fromEntries(
            Object.entries(args.sessionOptions).map(([key, value]) => [key, String(value)])
          )
        }
      : {}),
    ...(args.extraAgentArgs !== undefined ? { extraAgentArgs: args.extraAgentArgs } : {}),
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.promptDelivery ? { promptDelivery: args.promptDelivery } : {}),
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    presentation: 'background' as const
  }
}

/** Negotiate once per launch so retries retain the same request after an upgrade. */
export function createAgentSessionTrustWorktreeOptions(trustWorktreeId: string | undefined) {
  let negotiated: Promise<{ trustWorktreeId?: string }> | undefined
  return (environmentId: string) => {
    negotiated ??= (async () => {
      if (!trustWorktreeId) {
        return {}
      }
      const supported = await runtimeEnvironmentSupportsCapability(
        environmentId,
        AGENT_SESSION_TRUST_WORKTREE_RUNTIME_CAPABILITY
      )
      return supported ? { trustWorktreeId } : {}
    })().catch((error: unknown) => {
      negotiated = undefined
      throw error
    })
    return negotiated
  }
}
