import { composeAgentLaunchModel } from './agent-session-option-launch'
import {
  analyzeAgentChoiceArgs,
  type ChoiceOccurrence,
  type AgentChoicePublicationContext
} from './agent-choice-args'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from './agent-session-option-catalog'
import {
  normalizeAgentModelOptionChoices,
  type AgentChoicePatch,
  type AgentDedicatedChoices
} from './agent-launch-choices'
import { agentPermissionChoices } from './tui-agent-permission-choice'
import type { TuiAgent } from './tui-agent'

export type AgentChoiceArgsInput = {
  agent: TuiAgent
  userArgs: string
  choices: AgentDedicatedChoices
  mode: 'load' | 'arguments-edit' | 'choice-edit'
  keys: ReadonlySet<string>
  patch?: AgentChoicePatch
  /** Prefix carriers belong to the accepted source, outside this residual replacement. */
  retainedPrefixLength?: number
  retainedKeys?: ReadonlySet<string>
  permissionRanges?: readonly ChoiceOccurrence[]
  sourceEdit?: boolean
  publication?: AgentChoicePublicationContext
}

export function reconcileAgentChoiceArgs(input: AgentChoiceArgsInput): {
  userArgs: string
  choices: AgentDedicatedChoices
} {
  const { userArgs, choices } = reconcileAgentChoiceArgsDetailed(input)
  return { userArgs, choices }
}

export function reconcileAgentChoiceArgsDetailed(input: AgentChoiceArgsInput) {
  const { agent, userArgs, keys, mode, patch } = input
  const analysis = analyzeAgentChoiceArgs(agent, userArgs, input.publication)
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  const choices: AgentDedicatedChoices & { options: Record<string, string> } = {
    ...input.choices,
    options: { ...input.choices.options }
  }
  if ('publishedKeys' in analysis && analysis.publishedKeys) {
    for (const key of analysis.publishedKeys) {
      if (key === 'model') {
        delete choices.model
        for (const option of findCatalogModel(
          catalog ?? { models: [], modelApply: {} },
          input.choices.model ?? ''
        )?.options ?? []) {
          if (option.apply.composedIntoModel) {
            delete choices.options[option.id]
          }
        }
      } else if (key !== 'permissionMode') {
        delete choices.options[key]
      }
    }
  }
  const effects: AgentChoicePatch = {}
  const patched = (key: string) =>
    key === 'model'
      ? patch?.model
      : key === 'permissionMode'
        ? patch?.permissionMode
        : patch?.options?.[key]
  const read = (key: string) =>
    key === 'model'
      ? choices.model
      : key === 'permissionMode'
        ? choices.permissionMode
        : choices.options[key]
  const write = (key: string, value: string | null, explicit = true, target = choices) => {
    const publish = mode !== 'load' && explicit
    if (key === 'model') {
      const previousModel = input.publication ? input.choices.model : target.model
      if (value !== previousModel) {
        const independent = getAgentSessionOptionLaunchCatalog(agent)?.unknownModelOptions ?? []
        target.options = Object.fromEntries(
          Object.entries(target.options).filter(([id]) => {
            const retain =
              (value === null || previousModel === undefined) &&
              independent.some((option) => option.id === id && option.apply.launchArgs)
            if (!retain && publish) {
              effects.options = { ...effects.options, [id]: null }
            }
            return retain
          })
        )
      }
      target.model = value ?? undefined
      if (publish) {
        effects.model = value
      }
    } else if (key === 'permissionMode') {
      target.permissionMode = agentPermissionChoices(agent).find((choice) => choice === value)
      if (publish) {
        effects.permissionMode = target.permissionMode ?? 'default'
      }
    } else if (value === null) {
      delete target.options[key]
      if (publish) {
        effects.options = { ...effects.options, [key]: null }
      }
    } else {
      target.options[key] = value
      if (publish) {
        effects.options = { ...effects.options, [key]: value }
      }
    }
  }
  const composedModel = composeAgentLaunchModel(agent, {
    ...input.choices.options,
    model: input.choices.model
  })
  const composedPatch =
    mode === 'choice-edit' &&
    catalog?.models
      .find((model) => model.id === input.choices.model)
      ?.options.some((option) => option.apply.composedIntoModel && patched(option.id) !== undefined)
  const occurrences = analysis.occurrences.map((entry) =>
    entry.key === 'model' && input.choices.model && entry.value === composedModel
      ? { ...entry, value: input.choices.model, composed: true }
      : { ...entry, composed: false }
  )
  const counts = new Map<string, number>()
  occurrences.forEach((entry) => counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1))
  const selected = occurrences.filter((entry, _, all) => {
    if (
      !keys.has(entry.key) ||
      input.retainedKeys?.has(entry.key) ||
      entry.start < (input.retainedPrefixLength ?? 0)
    ) {
      return false
    }
    const next = mode === 'choice-edit' ? patched(entry.key) : undefined
    if (next !== undefined) {
      const removing =
        next === null || next === 'default' || (entry.key === 'permissionMode' && next === 'own')
      return (
        (entry.owned || (input.sourceEdit && entry.source)) &&
        (!removing || entry.value === read(entry.key))
      )
    }
    if (entry.composed && composedPatch) {
      return entry.owned
    }
    if ('publicationOwned' in entry && entry.publicationOwned) {
      return true
    }
    if (!entry.lift || counts.get(entry.key) !== 1) {
      return false
    }
    if (entry.key !== 'model' && entry.key !== 'permissionMode') {
      const model =
        mode === 'choice-edit' && patch?.model !== undefined
          ? (patch.model ?? undefined)
          : (all.find((other) => other.key === 'model' && other.lift && counts.get('model') === 1)
              ?.value ?? choices.model)
      const option =
        (
          findCatalogModel(catalog ?? { models: [], modelApply: {} }, model ?? '')?.options ??
          catalog?.unknownModelOptions
        )?.find((option) => option.id === entry.key) ??
        catalog?.unknownModelOptions?.find((option) => option.id === entry.key)
      if (
        !option?.apply.launchArgs ||
        (option.kind.type === 'boolean'
          ? entry.valueType !== 'boolean' || (entry.value !== 'true' && entry.value !== 'false')
          : option.kind.choices.length > 0 &&
            !option.kind.choices.some((choice) => choice.value === entry.value))
      ) {
        return false
      }
    }
    if (
      !normalizeAgentModelOptionChoices({ model: entry.value }) ||
      entry.value.trim() !== entry.value
    ) {
      return false
    }
    const previous = read(entry.key)
    return mode !== 'load' || previous === undefined || previous === entry.value
  })
  const declaredOptions = new Map(
    (catalog?.unknownModelOptions ?? []).map((option) => [option.id, option])
  )
  for (const model of catalog?.models ?? []) {
    for (const option of model.options) {
      declaredOptions.set(option.id, option)
    }
  }
  const recognized = occurrences.filter(
    (entry) =>
      keys.has(entry.key) &&
      entry.source &&
      (declaredOptions.get(entry.key)?.kind.type !== 'boolean' || entry.valueType === 'boolean') &&
      counts.get(entry.key) === 1
  )
  const cuts = input.permissionRanges
    ? [...selected.filter((entry) => entry.key !== 'permissionMode'), ...input.permissionRanges]
    : selected
  const cut = analysis.cut(cuts)
  const lifted =
    cut === null
      ? []
      : selected.filter((entry) => mode !== 'choice-edit' || patched(entry.key) === undefined)
  const model = lifted.find((entry) => entry.key === 'model')
  if (model) {
    write('model', model.value, mode === 'arguments-edit')
    if (input.publication && model.composed) {
      for (const option of findCatalogModel(
        catalog ?? { models: [], modelApply: {} },
        input.choices.model ?? ''
      )?.options ?? []) {
        const value = input.choices.options?.[option.id]
        // The same model carrier also conserves saved composed values that emit nothing.
        if (option.apply.composedIntoModel && value !== undefined) {
          choices.options[option.id] = value
        }
      }
    }
  }
  if (mode === 'choice-edit' && patch?.model !== undefined) {
    write('model', patch.model)
  }
  lifted
    .filter((entry) => entry.key !== 'model')
    .forEach((entry) => write(entry.key, entry.value, mode === 'arguments-edit'))
  if (patch && mode === 'choice-edit') {
    Object.entries(patch.options ?? {}).forEach(([key, value]) => write(key, value))
    if (patch.permissionMode !== undefined) {
      write('permissionMode', patch.permissionMode === 'default' ? null : patch.permissionMode)
    }
  }
  const sourceChoices = {
    ...choices,
    options: { ...choices.options }
  }
  for (const entry of recognized) {
    if (mode === 'choice-edit' && patched(entry.key) !== undefined) {
      continue
    }
    const publish =
      mode === 'arguments-edit' &&
      !input.retainedKeys?.has(entry.key) &&
      entry.start >= (input.retainedPrefixLength ?? 0) &&
      Boolean(normalizeAgentModelOptionChoices({ model: entry.value })) &&
      entry.value.trim() === entry.value
    if (entry.key === 'model' && !publish) {
      sourceChoices.model = entry.value
    } else {
      write(entry.key, entry.value, publish, sourceChoices)
    }
  }
  const normalized: AgentDedicatedChoices = {
    ...normalizeAgentModelOptionChoices(choices),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {})
  }
  return {
    userArgs: cut ?? userArgs,
    choices: normalized,
    selected: cut === null ? [] : cuts,
    effects,
    sourceChoices,
    recognized,
    analysis,
    source: userArgs
  }
}
