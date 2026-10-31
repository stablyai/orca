import { shallow } from 'zustand/shallow'
import { acceptAgentPickerArguments } from '../../../../shared/agent-launch-picker-edits'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import {
  selectSourceControlActionRecipe,
  pickSourceControlActionAgent,
  type CurrentActionSelection
} from '../../../../shared/source-control-action-selection'
import {
  sourceControlActionExecutionArgs,
  selectedSourceControlActionPreferences
} from '../../../../shared/source-control-action-launch-preferences'

export function sourceControlPickerDraft(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  surface = entry.defaultSurface,
  observedAgent: AgentPickerEntry['agent'] | null = entry.agent
): AgentPickerDraft {
  const bound = pickSourceControlActionAgent(selection, entry.agent, observedAgent, surface)
  const recipe = selectSourceControlActionRecipe(bound)
  const preferences = selectedSourceControlActionPreferences(recipe, entry.agent)
  const modelSelection = recipe.resolvedChoiceSources.model
  const delegated = [
    ...(modelSelection?.model?.agentId === entry.agent && modelSelection.model.value === null
      ? ['model']
      : []),
    ...Object.entries(modelSelection?.options ?? {}).flatMap(([key, value]) =>
      value.agentId === entry.agent && value.value === null ? [key] : []
    )
  ]
  return {
    agent: entry.agent,
    surface,
    delegated,
    choices: {
      ...(preferences?.model ? { model: preferences.model } : {}),
      ...(preferences?.options ? { options: preferences.options } : {}),
      ...(preferences?.permissionMode ? { permissionMode: preferences.permissionMode } : {})
    },
    arguments: sourceControlActionExecutionArgs(recipe, entry.agent),
    recipeEdits: { selection: bound, changed: false, argumentsAuthored: false },
    argumentsOwner: entry.ownerKey
  }
}

/** Save only authored deltas; inherited choices remain owned by their existing recipe scope. */
export function applySourceControlPickerDraft(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): CurrentActionSelection {
  draft = acceptAgentPickerArguments(entry, draft)
  const receipt = draft.recipeEdits
  if (!receipt?.changed || draft.agent !== entry.agent) {
    return selection
  }
  return {
    current: {
      ...selection.current,
      agentArgs: receipt.selection.current.agentArgs,
      argumentChoices: receipt.selection.current.argumentChoices,
      agentId: selection.current.agentId,
      surface: selection.current.surface
    },
    source: {
      ...selection.source,
      authoredPreferences: receipt.selection.source.authoredPreferences,
      ...(selection.source.scope === 'repo' && receipt.selection.source.scope === 'repo'
        ? { ownsArgs: receipt.selection.source.ownsArgs }
        : {})
    }
  }
}

/** Template edits do not change the staged setup's source or ownership. */
export function sameSourceControlSetupSelection(
  a: CurrentActionSelection,
  b: CurrentActionSelection
) {
  const x = a.current.argumentChoices
  const y = b.current.argumentChoices
  return (
    a.current.agentId === b.current.agentId &&
    a.current.surface === b.current.surface &&
    a.current.agentArgs === b.current.agentArgs &&
    (x === y ||
      (!!x &&
        !!y &&
        x.syntaxAgent === y.syntaxAgent &&
        x.nodes.length === y.nodes.length &&
        x.nodes.every((node, i) => node.at === y.nodes[i].at && node.text === y.nodes[i].text))) &&
    a.source.scope === b.source.scope &&
    a.source.authoredAgentId === b.source.authoredAgentId &&
    samePreferences(a.source.authoredPreferences, b.source.authoredPreferences) &&
    (a.source.scope !== 'repo' ||
      (b.source.scope === 'repo' &&
        a.source.ownsArgs === b.source.ownsArgs &&
        samePreferences(a.source.parentPreferences, b.source.parentPreferences)))
  )
}

function samePreferences(
  a: CurrentActionSelection['source']['authoredPreferences'],
  b: CurrentActionSelection['source']['authoredPreferences']
) {
  const x = a?.modelSelection
  const y = b?.modelSelection
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.agentId === b.agentId &&
      a.model === b.model &&
      a.permissionMode === b.permissionMode &&
      shallow(a.options, b.options) &&
      (x === y ||
        (!!x &&
          !!y &&
          x.base === y.base &&
          shallow(x.model, y.model) &&
          Object.keys(x.options ?? {}).length === Object.keys(y.options ?? {}).length &&
          Object.entries(x.options ?? {}).every(([key, value]) =>
            shallow(value, y.options?.[key])
          ))))
  )
}
