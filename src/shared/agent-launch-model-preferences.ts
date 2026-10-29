/** Use the launch catalog for every caller's model/effort validation so CLI and orchestration refusals agree. */

import type { AgentLaunchPreferences } from './agent-session-host-authority'
import { findCatalogModel, findCatalogOption } from './agent-session-option-catalog'
import {
  getAgentSessionOptionLaunchCatalog,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { TuiAgent } from './tui-agent'

export const OPENCODE_MODEL_VERSION_REFUSAL =
  'OpenCode cannot safely start with a chosen model on this version. Update OpenCode to a supported release, or omit the model choice.'
export const OPENCODE_MODEL_TRANSPORT_REFUSAL =
  'OpenCode cannot apply this model choice to this launch. Start a fresh local terminal with supported launch arguments, or omit the model choice.'
export const OPENCODE_MODEL_CONFIG_REFUSAL =
  'OpenCode could not apply this model choice to the launch configuration. Check the OpenCode launch configuration and try again, or omit the model choice.'

export type AgentLaunchModelPreferenceRefusal = {
  code: 'invalid_argument' | 'capability_unsupported'
  message: string
}

export type AgentLaunchModelPreferenceCheck =
  | { preferences: AgentLaunchPreferences | undefined }
  | { refusal: AgentLaunchModelPreferenceRefusal }

export function checkAgentLaunchModelPreferences(args: {
  agent: TuiAgent
  /** OpenCode model choices need a fresh terminal on a supported execution host. */
  openCodeModelLaunchSupported?: boolean
  createsWorktree?: boolean
  model?: string
  effort?: string
}): AgentLaunchModelPreferenceCheck {
  if (args.effort && !args.model) {
    return refuse('invalid_argument', '--effort requires --model.')
  }
  if (!args.model) {
    return { preferences: undefined }
  }
  if (args.agent === 'opencode' && args.createsWorktree) {
    return refuse(
      'capability_unsupported',
      'OpenCode model selection requires an existing worktree. Use --worktree current or an existing worktree selector, or omit --model.'
    )
  }
  if (args.agent === 'opencode' && args.openCodeModelLaunchSupported !== true) {
    return refuse(
      'capability_unsupported',
      'OpenCode cannot apply a model choice on this execution host. Use a fresh local terminal in an existing workspace, or omit --model.'
    )
  }

  const catalog = getAgentSessionOptionLaunchCatalog(args.agent)
  if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
    return refuse(
      'invalid_argument',
      `Agent ${args.agent} does not support launch-time model selection. Omit --model to run the model from its own config.`
    )
  }

  if (args.effort) {
    const model = findCatalogModel(catalog, args.model)
    const option =
      findCatalogOption(model, 'effort') ??
      (!model
        ? catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
        : undefined)
    if (
      option?.kind.type !== 'select' ||
      !option.kind.choices.some((choice) => choice.value === args.effort)
    ) {
      return refuse(
        'invalid_argument',
        `Agent ${args.agent} model ${args.model} does not support effort ${args.effort}.`
      )
    }
  }

  const requested: AgentLaunchPreferences = {
    model: args.model,
    ...(args.effort ? { effort: args.effort } : {})
  }
  const resolved = resolveAgentSessionOptionLaunch(args.agent, requested, [], false)
  if (
    resolved.appliedValues.model !== args.model ||
    resolved.appliedValues.effort !== args.effort
  ) {
    return refuse(
      'invalid_argument',
      `Agent ${args.agent} cannot apply the requested launch preferences.`
    )
  }
  return { preferences: requested }
}

function refuse(
  code: AgentLaunchModelPreferenceRefusal['code'],
  message: string
): AgentLaunchModelPreferenceCheck {
  return { refusal: { code, message } }
}
