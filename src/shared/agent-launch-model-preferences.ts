/**
 * Whether a launch can start `agent` on the model and effort its caller named, by the same catalog
 * the launch itself applies. One rule for every caller that takes `--model`/`--effort`, so an
 * orchestration worker and a plain CLI launch refuse the same requests with the same words.
 */

import type { AgentLaunchPreferences } from './agent-session-host-authority'
import { findCatalogModel, findCatalogOption } from './agent-session-option-catalog'
import {
  getAgentSessionOptionLaunchCatalog,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { TuiAgent } from './tui-agent'
import { isOmpThinkingLevel } from './omp-model-list-probe'

export type AgentLaunchModelPreferenceRefusal = {
  code: 'invalid_argument' | 'capability_unsupported'
  message: string
}

export type AgentLaunchModelPreferenceCheck =
  | { preferences: AgentLaunchPreferences | undefined }
  | { refusal: AgentLaunchModelPreferenceRefusal }

export function checkAgentLaunchModelPreferences(args: {
  agent: TuiAgent
  /** OpenCode needs the execution host to verify its CLI before it can start on a chosen model. */
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
      'This OpenCode TUI cannot verify launch-time model selection. Omit --model or use a supported OpenCode CLI.'
    )
  }

  const catalog = getAgentSessionOptionLaunchCatalog(args.agent)
  if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
    return refuse(
      'invalid_argument',
      `Agent ${args.agent} does not support launch-time model selection. Omit --model to run the model from its own config.`
    )
  }

  if (args.agent === 'omp' && args.effort && !isOmpThinkingLevel(args.effort)) {
    return refuse('invalid_argument', `OMP does not support thinking ${args.effort}.`)
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
