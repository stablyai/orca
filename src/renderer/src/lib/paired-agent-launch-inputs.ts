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
import { resolveStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'

export async function pairedAgentLaunchInputs(args: {
  environmentId: string
  agent: TuiAgent
  complete: boolean
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
  const needsArguments = agentLaunchNeedsPreparedCommand(agent, sessionOptions)
  if (!needsArguments && !hasActionArgs) {
    return { ...explicitArgs, launchPreferences }
  }
  // Why: old hosts cannot express these combinations without the existing prepared launch.
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
  const shell = resolveStartupShell(status?.hostPlatform)
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
      snapshot.agentPermission?.userArgs ??
      snapshot.agentChoices?.userArgs ??
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
        settings
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
    platform: status?.hostPlatform ?? 'linux',
    isRemote: true,
    shell,
    agentArgs,
    sessionOptions
  })
  const { model, ...options } = inputs.sessionOptions ?? {}
  const permissionMode = readLaunchPermissionChoice(inputs.sessionOptions)
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
          ...(permissionMode ? { permissionMode } : {})
        }
      }
    ).args
  }
}
