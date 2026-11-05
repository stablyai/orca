import { useAppStore } from '@/store'
import { readHostAgentLaunchSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  agentLaunchNeedsPreparedCommand,
  toAgentLaunchPreferences
} from '../../../shared/agent-launch/choices/agent-launch-preferences'
import { projectAgentLaunchProfile } from '../../../shared/agent-launch/choices/agent-launch-profile'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { sourceControlActionAgentArgs } from '../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { liftAgentPermissionArgs } from '../../../shared/agent-launch/permissions/tui-agent-permission-lift'
import { readLaunchPermissionChoice } from '../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { YOLO_TUI_AGENT_ENV } from '../../../shared/agent-launch/permissions/tui-agent-permissions'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveHostAgentStartupShell } from '../../../shared/windows-terminal-shell'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'

export async function pairedAgentLaunchInputs(args: {
  environmentId: string
  agent: TuiAgent
  complete: boolean
  capable: boolean
  launchPlatform?: NodeJS.Platform
  launchShell?: AgentStartupShell
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  actionAgentArgs?: string
  agentArgs?: string | null
}) {
  const { agent, sessionOptions } = args
  const launchPreferences = toAgentLaunchPreferences(sessionOptions, agent)
  const explicitArgs = args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}
  const hasActionArgs = args.actionAgentArgs !== undefined
  if (args.complete && !hasActionArgs) {
    return {
      ...explicitArgs,
      sessionOptions,
      launchPreferences
    }
  }
  const permissionMode = readLaunchPermissionChoice(sessionOptions)
  const needsArguments =
    agentLaunchNeedsPreparedCommand(agent, sessionOptions) ||
    (!args.capable && permissionMode !== undefined)
  if (!needsArguments && !hasActionArgs) {
    return { ...explicitArgs, launchPreferences }
  }
  // Why: old paired servers keep their prepared launch for inputs they cannot express.
  if (
    (needsArguments && args.agentArgs !== undefined) ||
    (!args.complete &&
      Object.hasOwn(YOLO_TUI_AGENT_ENV, agent) &&
      readLaunchPermissionChoice(sessionOptions))
  ) {
    return { preparedAgentCommand: true }
  }
  const state = useAppStore.getState()
  const status = lastVerifiedRuntimeStatus(
    state.runtimeStatusByEnvironmentId.get(args.environmentId)
  )
  const owner = {
    environmentId: args.environmentId,
    pairingRevision: getRuntimeEnvironmentRevision(args.environmentId),
    runtimeId: status?.runtimeId
  }
  const snapshot = await readHostAgentLaunchSettings(owner).catch(() => null)
  if (
    !snapshot ||
    getRuntimeEnvironmentRevision(args.environmentId) !== owner.pairingRevision ||
    lastVerifiedRuntimeStatus(
      useAppStore.getState().runtimeStatusByEnvironmentId.get(args.environmentId)
    )?.runtimeId !== owner.runtimeId
  ) {
    return { preparedAgentCommand: true }
  }
  const platform = args.launchPlatform ?? status?.hostPlatform ?? 'linux'
  const shell = resolveStartupShell(
    platform,
    args.launchShell ??
      resolveHostAgentStartupShell({
        platform,
        isRemote: true,
        hostTerminalWindowsShell: status?.terminalWindowsShell
      })
  )
  const legacyPermission = liftAgentPermissionArgs(agent, snapshot.agentDefaultArgs[agent])
  // Why: snapshots with no readable permission cannot safely replace the action's Arguments.
  if (
    hasActionArgs &&
    !snapshot.agentPermission &&
    snapshot.agentDefaultArgs[agent] === undefined
  ) {
    return { preparedAgentCommand: true }
  }
  const settings = {
    agentDefaultArgs:
      snapshot.agentChoices?.userArgs ??
      snapshot.agentPermission?.userArgs ??
      snapshot.agentDefaultArgs,
    agentLaunchChoices: snapshot.agentChoices?.defaults,
    agentCmdOverrides: snapshot.agentCmdOverrides,
    agentPermissionDefault: snapshot.agentPermission?.default ?? legacyPermission.choice ?? 'own',
    agentPermissionOverrides: snapshot.agentPermission?.overrides
  }
  const agentArgs = hasActionArgs
    ? sourceControlActionAgentArgs(
        {
          agentArgs: args.actionAgentArgs,
          ...(readLaunchPermissionChoice(sessionOptions)
            ? {
                launchPreferences: {
                  agentId: agent,
                  permissionMode: readLaunchPermissionChoice(sessionOptions)
                }
              }
            : {})
        },
        agent,
        settings,
        shell
      )
    : args.agentArgs
  if (args.complete) {
    return { agentArgs, sessionOptions, launchPreferences }
  }
  if (!needsArguments) {
    return { agentArgs, launchPreferences }
  }
  const inputs = resolveAgentStartupPlanInputs({
    agent,
    settings,
    platform,
    isRemote: true,
    shell,
    agentArgs,
    sessionOptions
  })
  const { model, ...options } = inputs.sessionOptions ?? {}
  const compiledPermission = readLaunchPermissionChoice(inputs.sessionOptions)
  return {
    agentArgs: projectAgentLaunchProfile(
      agent,
      { agentPermissionDefault: 'own' },
      {
        target: 'terminal',
        shell,
        userArgs: inputs.agentArgs ?? '',
        choices: {
          ...(typeof model === 'string' ? { model } : {}),
          options: Object.fromEntries(
            Object.entries(options)
              .filter(([key]) => key !== 'permissionMode')
              .map(([key, value]) => [key, String(value)])
          ),
          ...(compiledPermission ? { permissionMode: compiledPermission } : {})
        }
      }
    ).args
  }
}
