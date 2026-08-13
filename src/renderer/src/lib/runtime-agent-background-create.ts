import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { AgentSessionRulesSettings } from '../../../shared/agent-session-rules-types'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/types'
import {
  addLegacyTerminalAttributionDisableRequest,
  withLegacyTerminalAttributionDisabledEnv
} from '../../../shared/legacy-terminal-attribution-env'
import {
  createAgentSessionCreateOperation,
  toAgentLaunchPreferences,
  withAgentSessionCreateOperationId
} from '@/runtime/agent-session-create-operation'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { runRemoteAgentSessionLaunch } from '@/runtime/remote-agent-session-launch'
import { AGENT_SESSION_CLIENT_DEFAULT_RULES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

export async function createRuntimeAgentBackgroundTerminal(args: {
  environmentId: string
  worktreeId: string
  tabId: string
  leafId: string
  agent: TuiAgent
  prompt?: string
  clientDefaultAgentSessionRules: AgentSessionRulesSettings
  sessionOptions?: Record<string, SessionOptionValue>
  legacy: {
    command: string
    env: Record<string, string>
    startupCommandDelivery?: StartupCommandDelivery
    launchConfig: SleepingAgentLaunchConfig
    launchToken: string
    title?: string
  }
}): Promise<{ terminal: RuntimeTerminalCreate }> {
  const operation = createAgentSessionCreateOperation()
  const launchPreferences = toAgentLaunchPreferences(args.sessionOptions)
  return await runRemoteAgentSessionLaunch({
    environmentId: args.environmentId,
    requiredHostAuthorityCapabilities: [AGENT_SESSION_CLIENT_DEFAULT_RULES_RUNTIME_CAPABILITY],
    hostAuthority: (authority) =>
      operation.run((clientOperationId) =>
        callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
          { kind: 'environment', environmentId: args.environmentId },
          'terminal.createAgentSession',
          withAgentSessionCreateOperationId(
            {
              worktree: toRuntimeWorktreeSelector(args.worktreeId),
              agent: args.agent,
              ...(args.prompt
                ? { prompt: args.prompt, promptDelivery: 'auto-submit' as const }
                : {}),
              ...(launchPreferences ? { launchPreferences } : {}),
              clientDefaultAgentSessionRules: args.clientDefaultAgentSessionRules,
              placement: { tabId: args.tabId, leafId: args.leafId },
              // Why: local renderer owns the hidden tab; remote runtime should not reveal UI.
              presentation: 'background'
            },
            clientOperationId
          ),
          {
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision: authority.expectedEnvironmentPairingRevision,
            expectedRuntimeId: authority.runtimeId
          }
        )
      ),
    legacy: ({ skipCompatibilityCheck, authority }) =>
      callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        { kind: 'environment', environmentId: args.environmentId },
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          command: args.legacy.command,
          ...(args.legacy.startupCommandDelivery
            ? { startupCommandDelivery: args.legacy.startupCommandDelivery }
            : {}),
          env: withLegacyTerminalAttributionDisabledEnv(args.legacy.env),
          envToDelete: addLegacyTerminalAttributionDisableRequest(undefined),
          launchConfig: args.legacy.launchConfig,
          launchToken: args.legacy.launchToken,
          launchAgent: args.agent,
          ...(args.legacy.title ? { title: args.legacy.title } : {}),
          tabId: args.tabId,
          leafId: args.leafId,
          presentation: 'background'
        },
        {
          timeoutMs: 15_000,
          skipCompatibilityCheck,
          expectedEnvironmentPairingRevision: authority.expectedEnvironmentPairingRevision,
          expectedRuntimeId: authority.runtimeId
        }
      )
  })
}
