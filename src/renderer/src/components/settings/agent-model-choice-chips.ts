import { analyzeAgentChoiceArgs } from '../../../../shared/agent-choice-args'
import { projectAgentLaunchProfile } from '../../../../shared/agent-launch-profile'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from '../../../../shared/agent-session-option-catalog'
import type {
  AgentChoicePatch,
  AgentDedicatedChoices
} from '../../../../shared/agent-launch-choices'
import type { AgentArgsProjectionContext } from '../../../../shared/agent-launch-picker-arguments'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentArgsChoice } from './AgentPermissionChoiceControls'

export function agentModelChoiceChips(
  agent: TuiAgent | null | undefined,
  label: string,
  selected: AgentDedicatedChoices | undefined,
  onRemove: (patch: AgentChoicePatch, text: string) => string,
  context?: AgentArgsProjectionContext
): AgentArgsChoice[] {
  if (!agent || (!selected && !context)) {
    return []
  }
  selected ??= {}
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  const model = findCatalogModel(catalog ?? { models: [], modelApply: {} }, selected.model ?? '')
  const options = new Map((catalog?.unknownModelOptions ?? []).map((option) => [option.id, option]))
  for (const option of model?.options ?? []) {
    options.set(option.id, option)
  }
  const projected = projectAgentLaunchProfile(agent, undefined, {
    target: 'terminal',
    userArgs: '',
    choices: selected
  })
  const analysis = analyzeAgentChoiceArgs(agent, projected.args)
  const carriers = new Map<string, string[]>()
  for (const occurrence of analysis.occurrences) {
    const key = occurrence.key
    const apply = key === 'model' ? catalog?.modelApply : options.get(key)?.apply
    if (
      !occurrence.source ||
      (key === 'permissionMode' && context?.permission?.opaque) ||
      (key !== 'permissionMode' && !apply?.cli?.length) ||
      (key === 'fastMode' && selected.options?.fastMode === 'false') ||
      (key === 'serviceTier' && selected.options?.serviceTier === 'default')
    ) {
      continue
    }
    const flags = carriers.get(key) ?? []
    flags.push(projected.args.slice(occurrence.start, occurrence.end))
    carriers.set(key, flags)
  }
  const literalCarriers = new Map<string, string[]>()
  for (const occurrence of context?.occurrences ?? []) {
    if (occurrence.key === 'permissionMode') {
      continue
    }
    if (carriers.has(occurrence.key) && !context?.literalKeys.includes(occurrence.key)) {
      continue
    }
    const flags = literalCarriers.get(occurrence.key) ?? []
    flags.push(context!.source.slice(occurrence.start, occurrence.end))
    literalCarriers.set(occurrence.key, flags)
  }
  if (context?.permission && !context.permission.opaque) {
    literalCarriers.set('permissionMode', [context.permission.flag])
  }
  for (const [key, flags] of literalCarriers) {
    carriers.set(key, flags)
  }
  return [...carriers].map(([key, flags]) => ({
    key,
    label,
    flag: [...new Set(flags)].join(' '),
    ...(literalCarriers.has(key) || context?.literalKeys.includes(key)
      ? { source: 'arguments' as const }
      : {}),
    onRemove: (text) =>
      onRemove(
        key === 'model'
          ? { model: null }
          : key === 'permissionMode'
            ? { permissionMode: 'own' }
            : {
                options: {
                  [key]: key === 'fastMode' ? 'false' : key === 'serviceTier' ? 'default' : null
                }
              },
        text
      )
  }))
}
