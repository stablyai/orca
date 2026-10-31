import type { AgentStartupShell } from './tui-agent-startup-shell'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import {
  AGENT_LAUNCH_CHOICE_KEYS,
  normalizeAgentModelOptionChoices,
  type AgentChoicePatch
} from './agent-launch-choices'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import type { AgentLaunchSettingsSource } from './agent-launch-settings'
import { normalizeTuiAgentArgsRecord, resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'
import {
  applyAgentPermissionOverrides,
  agentPermissionArgs,
  resolveAgentPermission
} from './tui-agent-permission-choice'
import type { TuiAgent } from './tui-agent'

/** Representation adapters share one reconciler and commit the complete agent tuple. */
export function agentLaunchChoiceUpdates(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  input: { patch?: AgentChoicePatch; userArgs?: string },
  legacy?: { target: 'terminal' | 'legacy-permission'; shell: AgentStartupShell }
): AgentLaunchSettingsSource {
  const publication =
    legacy &&
    projectAgentLaunchProfile(agent, settings, {
      target: legacy.target,
      shell: legacy.shell
    })
  if (publication && input.userArgs?.trim() === publication.args.trim()) {
    return {}
  }
  const permissionMode = resolveAgentPermission(agent, settings).choice
  const result = reconcileAgentChoiceArgs({
    agent,
    userArgs: input.userArgs ?? settings.agentDefaultArgs?.[agent] ?? '',
    choices: {
      ...settings.agentLaunchChoices?.[agent],
      ...(legacy?.target === 'terminal' ? {} : { permissionMode })
    },
    keys: legacy
      ? new Set([
          ...AGENT_LAUNCH_CHOICE_KEYS,
          ...Object.keys(settings.agentLaunchChoices?.[agent]?.options ?? {})
        ])
      : AGENT_LAUNCH_CHOICE_KEYS,
    mode: input.patch ? 'choice-edit' : 'arguments-edit',
    patch: input.patch,
    ...(legacy && publication && settings.agentLaunchChoices?.[agent]
      ? {
          publication: {
            shell: legacy.shell,
            generatedArgs: publication.args,
            launch: publication.launch,
            ...(publication.permissionArgs
              ? { permissionMode: publication.choices.permissionMode }
              : {})
          }
        }
      : {})
  })
  const removedPermission =
    legacy?.target === 'terminal' &&
    agentPermissionArgs(agent, permissionMode) &&
    resolveTuiAgentLaunchArgs(agent, settings, undefined, legacy?.shell).trim() !==
      (settings.agentDefaultArgs?.[agent]?.trim() ?? '')
  const nextPermission =
    result.choices.permissionMode ?? (removedPermission ? 'own' : permissionMode)
  const choices = { ...settings.agentLaunchChoices }
  const model = normalizeAgentModelOptionChoices(result.choices)
  if (model) {
    choices[agent] = model
  } else {
    delete choices[agent]
  }
  return {
    agentLaunchChoices: choices,
    agentDefaultArgs: normalizeTuiAgentArgsRecord({
      ...settings.agentDefaultArgs,
      [agent]: result.userArgs
    }),
    ...(input.patch?.permissionMode === 'default'
      ? applyAgentPermissionOverrides(settings, [agent], 'default')
      : nextPermission !== permissionMode
        ? applyAgentPermissionOverrides(settings, [agent], nextPermission)
        : {})
  }
}
