import { hasExtraAgentArgs } from '../../../shared/agent-launch/startup/automation-extra-agent-args'
import type { AgentPaneLaunchRequest } from '../../../shared/agent-launch/contracts/agent-pane-launch-request'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan } from '../../../shared/agent-launch/startup/tui-agent-startup'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import type { LaunchAgentBackgroundSessionArgs } from './agent-background-session-contract'
import type { AgentBackgroundLaunchHost } from './agent-background-session-launch-host'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { createAgentSessionLaunchOptions } from '@/runtime/agent-session-launch-options'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { StartupCommandDelivery } from '../../../shared/agent-launch/startup/codex-startup-delivery'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  agentLaunchNeedsPreparedCommand,
  toAgentLaunchPreferences
} from '../../../shared/agent-launch/choices/agent-launch-preferences'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from '@/runtime/agent-session-create-operation'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  agentSessionCreateCapabilities,
  agentSessionCreateRequest
} from '@/runtime/agent-session-create-request'
import { AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-runtime-capabilities'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { runRemoteAgentSessionLaunch } from '@/runtime/remote-agent-session-launch'

type RuntimeAgentBackgroundCreateArgs = {
  environmentId: string
  worktreeId: string
  tabId: string
  leafId: string
  agent: TuiAgent
  agentArgs?: string | null
  prompt?: string
  sessionOptions?: Record<string, SessionOptionValue>
  extraAgentArgs?: string
  legacy: () => Promise<{
    agentArgs?: string | null
    command: string
    env: Record<string, string>
    startupCommandDelivery?: StartupCommandDelivery
    sessionOptions?: Record<string, SessionOptionValue>
    launchConfig: SleepingAgentLaunchConfig
    launchToken: string
    title?: string
  }>
}

export async function createRuntimeAgentBackgroundTerminal(
  args: RuntimeAgentBackgroundCreateArgs
): Promise<{ terminal: RuntimeTerminalCreate }> {
  return (await prepareRuntimeAgentBackgroundTerminal(args.environmentId))(args)
}

export async function prepareRuntimeAgentBackgroundTerminal(environmentId: string) {
  const { complete, capable } = await agentSessionCreateCapabilities(environmentId)
  return (args: RuntimeAgentBackgroundCreateArgs): Promise<{ terminal: RuntimeTerminalCreate }> =>
    createPreparedRuntimeAgentBackgroundTerminal(args, capable, complete)
}

async function createPreparedRuntimeAgentBackgroundTerminal(
  args: RuntimeAgentBackgroundCreateArgs,
  capable: boolean,
  complete: boolean
): Promise<{ terminal: RuntimeTerminalCreate }> {
  const keyboardProtocol = buildDefaultTerminalOptions().vtExtensions?.kittyKeyboard
  const launchOptions = createAgentSessionLaunchOptions(keyboardProtocol)
  const operation = createAgentSessionCreateOperation()
  if (!complete && args.sessionOptions !== undefined) {
    throw new Error('Update Orca on this host to use agent launch settings.')
  }
  if (!complete && hasExtraAgentArgs(args.extraAgentArgs) && args.agentArgs === undefined) {
    throw new Error("Extra arguments can't be applied to a paired server's workspace from here.")
  }
  const legacy = complete ? undefined : await args.legacy()
  const applied = legacy?.sessionOptions ?? args.sessionOptions
  const agentArgs = !complete && args.extraAgentArgs ? legacy?.agentArgs : args.agentArgs
  const launchPreferences = toAgentLaunchPreferences(
    capable ? args.sessionOptions : applied,
    args.agent
  )
  return await runRemoteAgentSessionLaunch({
    environmentId: args.environmentId,
    ...(complete
      ? { hostAuthorityCapability: AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY }
      : {}),
    hostAuthority:
      !complete && agentLaunchNeedsPreparedCommand(args.agent, applied)
        ? undefined
        : () =>
            operation.run(async (clientOperationId) =>
              callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
                { kind: 'environment', environmentId: args.environmentId },
                'terminal.createAgentSession',
                withAgentSessionCreateOperationId(
                  {
                    ...(await launchOptions(args.environmentId, legacy?.launchConfig)),
                    ...agentSessionCreateRequest({
                      worktreeId: args.worktreeId,
                      agent: args.agent,
                      agentArgs,
                      ...(complete
                        ? {
                            sessionOptions: args.sessionOptions,
                            extraAgentArgs: args.extraAgentArgs
                          }
                        : {}),
                      prompt: args.prompt,
                      // Follow-up prompts arrive after startup but still need an unattended launch.
                      promptDelivery: 'auto-submit',
                      launchPreferences
                    }),
                    placement: { tabId: args.tabId, leafId: args.leafId },
                    // Why: local renderer owns the hidden tab; remote runtime should not reveal UI.
                    presentation: 'background'
                  },
                  clientOperationId
                ),
                { timeoutMs: 15_000 }
              )
            ),
    legacy: async ({ skipCompatibilityCheck }) => {
      if (args.sessionOptions !== undefined) {
        throw new Error(
          'This host could not apply the agent launch settings. Update Orca on the host and try again.'
        )
      }
      if (hasExtraAgentArgs(args.extraAgentArgs) && args.agentArgs === undefined) {
        throw new Error(
          "Extra arguments can't be applied to a paired server's workspace from here."
        )
      }
      const prepared = legacy ?? (await args.legacy())
      return callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        { kind: 'environment', environmentId: args.environmentId },
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          command: prepared.command,
          ...(keyboardProtocol === true ? { terminalKittyKeyboardProtocol: true } : {}),
          ...(prepared.startupCommandDelivery
            ? { startupCommandDelivery: prepared.startupCommandDelivery }
            : {}),
          env: prepared.env,
          launchConfig: prepared.launchConfig,
          launchToken: prepared.launchToken,
          launchAgent: args.agent,
          ...(prepared.title ? { title: prepared.title } : {}),
          tabId: args.tabId,
          leafId: args.leafId,
          presentation: 'background'
        },
        { timeoutMs: 15_000, skipCompatibilityCheck }
      )
    }
  })
}

/** Old servers accept a prepared command; compile only after selecting that protocol route. */
export async function buildLegacyAgentBackgroundStartup(
  args: LaunchAgentBackgroundSessionArgs,
  host: AgentBackgroundLaunchHost,
  environmentId: string,
  commandPrompt: string
) {
  const store = useAppStore.getState()
  const preferences = await ensureAgentLaunchPreferences(store, {
    kind: 'git-worktree',
    runtimeEnvironmentId: environmentId
  })
  const inputs = resolveAgentStartupPlanInputs({
    agent: args.agent,
    settings: {
      ...store.settings,
      agentLaunchChoices: preferences.agentLaunchChoices ?? store.settings?.agentLaunchChoices,
      ...(!host.isLocalHost ? { terminalWindowsShell: undefined } : {})
    },
    platform: host.platform,
    isRemote: host.isRemote,
    shell: undefined,
    extraAgentArgs: args.extraAgentArgs,
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.sessionOptions !== undefined ? { sessionOptions: args.sessionOptions } : {}),
    suppressStartupUpdatePrompt: true
  })
  const plan = buildAgentStartupPlan({
    ...inputs,
    prompt: commandPrompt,
    allowEmptyPromptLaunch: !commandPrompt
  })
  if (!plan) {
    throw new Error(`Could not build launch command for ${args.agent}.`)
  }
  return { ...plan, agentArgs: inputs.agentArgs }
}

export function agentBackgroundPaneLaunchRequest(
  args: LaunchAgentBackgroundSessionArgs,
  commandPrompt: string
): AgentPaneLaunchRequest {
  return {
    launch: {
      agent: args.agent,
      target: { kind: 'existing', worktree: `id:${args.worktreeId}` },
      ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
      ...(args.sessionOptions !== undefined ? { sessionOptions: { ...args.sessionOptions } } : {}),
      ...(commandPrompt ? { prompt: { text: commandPrompt, delivery: 'submit' } } : {}),
      ...(args.launchSource ? { launchSource: args.launchSource } : {})
    },
    ...(args.extraAgentArgs !== undefined ? { extraAgentArgs: args.extraAgentArgs } : {}),
    startupPromptCarry: 'force-line',
    suppressStartupUpdatePrompt: true,
    returnLaunchFailure: true
  }
}
