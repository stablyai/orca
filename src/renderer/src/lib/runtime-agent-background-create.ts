import { hostSupportsLaunchChoices } from '@/components/settings/agent-launch-settings-transport'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { createAgentSessionKeyboardOptions } from '@/runtime/agent-session-keyboard-capability'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  agentLaunchNeedsPreparedCommand,
  toAgentLaunchPreferences
} from '../../../shared/agent-launch-preferences'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from '@/runtime/agent-session-create-operation'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { runRemoteAgentSessionLaunch } from '@/runtime/remote-agent-session-launch'

type RuntimeAgentBackgroundCreateArgs = {
  environmentId: string
  worktreeId: string
  tabId: string
  leafId: string
  agent: TuiAgent
  prompt?: string
  sessionOptions?: Record<string, SessionOptionValue>
  legacy: {
    command: string
    env: Record<string, string>
    startupCommandDelivery?: StartupCommandDelivery
    sessionOptions?: Record<string, SessionOptionValue>
    launchConfig: SleepingAgentLaunchConfig
    launchToken: string
    title?: string
  }
}

export async function createRuntimeAgentBackgroundTerminal(
  args: RuntimeAgentBackgroundCreateArgs
): Promise<{ terminal: RuntimeTerminalCreate }> {
  return (await prepareRuntimeAgentBackgroundTerminal(args.environmentId))(args)
}

export async function prepareRuntimeAgentBackgroundTerminal(environmentId: string) {
  const capable = await hostSupportsLaunchChoices({ environmentId })
  return (args: RuntimeAgentBackgroundCreateArgs): Promise<{ terminal: RuntimeTerminalCreate }> =>
    createPreparedRuntimeAgentBackgroundTerminal(args, capable)
}

async function createPreparedRuntimeAgentBackgroundTerminal(
  args: RuntimeAgentBackgroundCreateArgs,
  capable: boolean
): Promise<{ terminal: RuntimeTerminalCreate }> {
  const keyboardProtocol = buildDefaultTerminalOptions().vtExtensions?.kittyKeyboard
  const keyboardOptions = createAgentSessionKeyboardOptions(keyboardProtocol)
  const operation = createAgentSessionCreateOperation()
  const applied = args.legacy.sessionOptions ?? args.sessionOptions
  const launchPreferences = toAgentLaunchPreferences(
    capable ? args.sessionOptions : applied,
    args.agent
  )
  return await runRemoteAgentSessionLaunch({
    environmentId: args.environmentId,
    hostAuthority: agentLaunchNeedsPreparedCommand(args.agent, applied)
      ? undefined
      : () =>
          operation.run(async (clientOperationId) =>
            callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
              { kind: 'environment', environmentId: args.environmentId },
              'terminal.createAgentSession',
              withAgentSessionCreateOperationId(
                {
                  ...(await keyboardOptions(args.environmentId)),
                  worktree: toRuntimeWorktreeSelector(args.worktreeId),
                  agent: args.agent,
                  ...(args.prompt ? { prompt: args.prompt } : {}),
                  // Follow-up prompts arrive after startup but still need an unattended launch.
                  promptDelivery: 'auto-submit',
                  ...(launchPreferences ? { launchPreferences } : {}),
                  placement: { tabId: args.tabId, leafId: args.leafId },
                  // Why: local renderer owns the hidden tab; remote runtime should not reveal UI.
                  presentation: 'background'
                },
                clientOperationId
              ),
              { timeoutMs: 15_000 }
            )
          ),
    legacy: ({ skipCompatibilityCheck }) =>
      callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        { kind: 'environment', environmentId: args.environmentId },
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          command: args.legacy.command,
          ...(keyboardProtocol === true ? { terminalKittyKeyboardProtocol: true } : {}),
          ...(args.legacy.startupCommandDelivery
            ? { startupCommandDelivery: args.legacy.startupCommandDelivery }
            : {}),
          env: args.legacy.env,
          launchConfig: args.legacy.launchConfig,
          launchToken: args.legacy.launchToken,
          launchAgent: args.agent,
          ...(args.legacy.title ? { title: args.legacy.title } : {}),
          tabId: args.tabId,
          leafId: args.leafId,
          presentation: 'background'
        },
        { timeoutMs: 15_000, skipCompatibilityCheck }
      )
  })
}
