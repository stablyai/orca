import { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import type { AgentChoicePatch, AgentDedicatedChoices } from './agent-launch-choices'
import {
  actionModelSelectionChoices,
  normalizeActionModelSelection,
  readActionModelSelection
} from './source-control-action-model-selection'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import type { ActionModelSelection, SourceControlActionRecipe } from './source-control-ai-actions'

import {
  actionArgumentChoicesValue,
  lowerActionArgumentNodes,
  readActionArgumentNode,
  demoteActionArgumentChoices
} from './source-control-action-argument-document'
export type { ActionArgumentChoices } from './source-control-action-argument-document'
export {
  lowerActionArgumentChoices,
  trimActionArgumentDocument,
  readActionArgumentNode,
  normalizeActionArgumentDocument,
  lowerActionArgumentNodes,
  actionArgumentChoicesValue,
  transportActionArgumentChoices,
  demoteActionArgumentChoices
} from './source-control-action-argument-document'

function actionCutOffset(
  text: string,
  result: ReturnType<typeof reconcileAgentChoiceArgsDetailed>
) {
  const ranges = [...result.selected].sort((a, b) => a.start - b.start)
  let leading = 0
  let position = 0
  let rangeIndex = 0
  while (position < text.length) {
    const range = ranges[rangeIndex]
    if (range && position === range.start) {
      position = range.end
      rangeIndex++
      continue
    }
    if (!text[position].trim()) {
      leading++
      position++
      continue
    }
    break
  }
  return (position: number) => {
    let removed = 0
    for (const range of ranges) {
      if (position <= range.start) {
        break
      }
      removed += Math.min(position, range.end) - range.start
    }
    return Math.max(0, Math.min(result.userArgs.length, position - removed - leading))
  }
}

/** Cut positions come from the same original analysis, including permission cuts and trim. */
export function reconcileActionArgumentDocument<T extends SourceControlActionRecipe>(
  recipe: T,
  mode: 'load' | 'arguments-edit'
): T {
  return reconcileActionArgumentDocumentTransaction(recipe, mode).recipe
}

/** The receipt belongs to this operation, never to the saved document. */
export function reconcileActionArgumentDocumentTransaction<T extends SourceControlActionRecipe>(
  recipe: T,
  mode: 'load' | 'arguments-edit',
  input?: {
    choices: AgentDedicatedChoices
    permissionEligible: boolean
    literalKeys: readonly string[]
  }
) {
  if (!isTuiAgent(recipe.agentId) || typeof recipe.agentArgs !== 'string') {
    return { recipe }
  }
  const agent = recipe.agentId
  const authored = recipe.launchPreferences
  const selection = readActionModelSelection(authored)
  const eligible = actionModelSelectionChoices(selection, agent)
  const literal = actionArgumentChoicesValue(recipe)
  const effective = {
    ...literal,
    ...eligible,
    options: { ...literal.options, ...eligible.options },
    ...(authored?.agentId === agent ? { permissionMode: authored.permissionMode } : {})
  }
  const result = reconcileAgentChoiceArgsDetailed({
    agent,
    userArgs: recipe.agentArgs,
    choices: input?.choices ?? effective,
    mode,
    keys: new Set([
      'model',
      'effort',
      ...((input ? !input.permissionEligible : authored && authored.agentId !== agent)
        ? []
        : ['permissionMode'])
    ])
  })
  if (!result.selected.length) {
    return { recipe, result }
  }
  const ranges = [...result.selected].sort((a, b) => a.start - b.start)
  const map = actionCutOffset(recipe.agentArgs, result)
  const touched = new Set(result.selected.map((entry) => entry.key))
  const document = recipe.argumentChoices
  const foreign = document !== undefined && document.syntaxAgent !== agent
  const retained = (document?.nodes ?? [])
    .filter((node) => {
      const key = readActionArgumentNode(document!.syntaxAgent, node.text)!.key
      return (
        foreign ||
        (!touched.has(key) &&
          !(
            touched.has('model') &&
            key !== 'model' &&
            (!input || input.literalKeys.includes(key)) &&
            result.choices.options?.[key] === undefined
          ))
      )
    })
    .map((node) => ({ ...node, at: map(node.at) }))
  const nodes = [
    ...retained,
    ...ranges
      .filter((entry) => entry.key !== 'permissionMode')
      .map((entry) => ({
        at: map(entry.start),
        text: recipe.agentArgs!.slice(entry.start, entry.end)
      }))
  ].sort((a, b) => a.at - b.at)
  const committed = lowerActionArgumentNodes(
    {
      agentArgs: result.userArgs,
      argumentChoices: { syntaxAgent: agent, nodes }
    },
    (node) => foreign && retained.includes(node)
  )
  const preferences = { ...authored }
  const modelSelection = retireActionArgumentModelSelection(
    selection,
    agent,
    touched,
    result.choices,
    mode
  )
  if (touched.has('permissionMode')) {
    preferences.permissionMode = result.choices.permissionMode
  }
  const normalized = modelSelection && normalizeActionModelSelection(modelSelection)
  return {
    result,
    recipe: {
      ...recipe,
      agentArgs: committed.agentArgs,
      launchPreferences:
        normalized || preferences.permissionMode
          ? {
              agentId: authored?.agentId ?? agent,
              ...(normalized ? { modelSelection: normalized } : {}),
              ...(preferences.permissionMode ? { permissionMode: preferences.permissionMode } : {})
            }
          : undefined,
      argumentChoices: committed.argumentChoices?.nodes.length
        ? committed.argumentChoices
        : undefined
    }
  }
}

/** Retire only the authored keys selected by this document operation. */
export function retireActionArgumentModelSelection(
  value: ActionModelSelection | undefined,
  agent: TuiAgent,
  touched: ReadonlySet<string>,
  choices: AgentDedicatedChoices,
  mode: 'load' | 'arguments-edit',
  owns: (key: string) => boolean = () => true
) {
  if (!value) {
    return value
  }
  const next = { ...value, options: { ...value.options } }
  let changed = false
  if (
    mode === 'arguments-edit' &&
    touched.has('model') &&
    owns('model') &&
    next.model?.agentId === agent
  ) {
    delete next.model
    changed = true
  }
  for (const [key, entry] of Object.entries(next.options)) {
    if (
      owns(key) &&
      entry.agentId === agent &&
      ((mode === 'arguments-edit' && touched.has(key)) ||
        (touched.has('model') && entry.value !== null && choices.options?.[key] === undefined))
    ) {
      delete next.options[key]
      changed = true
    }
  }
  return changed ? normalizeActionModelSelection(next) : value
}

export function editActionArgumentChoices(
  recipe: SourceControlActionRecipe,
  agent: TuiAgent,
  selected: AgentDedicatedChoices,
  patch: AgentChoicePatch,
  text: string,
  base: ActionModelSelection['base'] = 'default'
) {
  const result = reconcileAgentChoiceArgsDetailed({
    agent,
    userArgs: text,
    choices: selected,
    mode: 'choice-edit',
    keys: new Set(['model', 'effort', 'permissionMode']),
    patch
  })
  const previous = recipe.launchPreferences
  const authored = readActionModelSelection(previous)
  const selection: ActionModelSelection = {
    ...authored,
    base: authored?.base ?? base,
    options: { ...authored?.options }
  }
  if (patch.model !== undefined) {
    selection.model = { agentId: agent, value: result.choices.model ?? null }
    for (const key of Object.keys(selected.options ?? {})) {
      if (
        result.choices.options?.[key] === undefined &&
        (!selection.options![key] || selection.options![key].agentId === agent)
      ) {
        selection.options![key] = { agentId: agent, value: null }
      }
    }
  }
  for (const key of Object.keys(patch.options ?? {})) {
    selection.options![key] = { agentId: agent, value: result.choices.options?.[key] ?? null }
  }
  const lifted = result.selected.filter(
    (entry) =>
      entry.key !== 'permissionMode' &&
      (entry.key === 'model' ? patch.model === undefined : patch.options?.[entry.key] === undefined)
  )
  const map = actionCutOffset(text, result)
  const nodes = (recipe.argumentChoices?.nodes ?? []).filter((node) => {
    const key = readActionArgumentNode(recipe.argumentChoices!.syntaxAgent, node.text)!.key
    return (
      !lifted.some((entry) => entry.key === key) &&
      !(key === 'model'
        ? patch.model !== undefined
        : patch.options?.[key] !== undefined ||
          (patch.model !== undefined && result.choices.options?.[key] === undefined))
    )
  })
  for (const entry of lifted) {
    if (entry.key === 'model' && selection.model?.agentId === agent) {
      delete selection.model
    } else if (selection.options![entry.key]?.agentId === agent) {
      delete selection.options![entry.key]
    }
  }
  const updatedNodes = [
    ...nodes.map((node) => ({ ...node, at: map(node.at) })),
    ...lifted.map((entry) => ({ at: map(entry.start), text: text.slice(entry.start, entry.end) }))
  ].sort((a, b) => a.at - b.at)
  const modelTouched = patch.model !== undefined || Object.keys(patch.options ?? {}).length > 0
  const preferences =
    authored || modelTouched ? normalizeActionModelSelection(selection) : undefined
  const permissionMode =
    patch.permissionMode !== undefined ? result.choices.permissionMode : previous?.permissionMode
  const next = {
    ...recipe,
    agentArgs: result.userArgs,
    launchPreferences:
      preferences || permissionMode
        ? {
            agentId: patch.permissionMode !== undefined ? agent : (previous?.agentId ?? agent),
            ...(preferences ? { modelSelection: preferences } : {}),
            ...(permissionMode ? { permissionMode } : {})
          }
        : undefined,
    argumentChoices: updatedNodes.length ? { syntaxAgent: agent, nodes: updatedNodes } : undefined
  }
  return updatedNodes.length && recipe.agentId !== agent ? demoteActionArgumentChoices(next) : next
}
