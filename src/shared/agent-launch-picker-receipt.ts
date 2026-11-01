import type { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import type { AgentPickerDraft, AgentPickerEntry } from './agent-launch-picker'
import type { AgentChoicePatch } from './agent-launch-choices'
import {
  editSourceControlActionArguments,
  selectSourceControlActionRecipe,
  type CurrentActionSelection
} from './source-control-action-selection'
import {
  selectedSourceControlActionPreferences,
  sourceControlActionExecutionArgs,
  demoteDisplacedActionArgumentChoices
} from './source-control-action-launch-preferences'
import {
  editActionArgumentChoices,
  editActionArgumentChoicePreferences,
  trimActionArgumentDocument,
  reconcileActionArgumentDocumentTransaction
} from './source-control-action-argument-choices'

type AcceptedChoices = ReturnType<typeof reconcileAgentChoiceArgsDetailed>

function editRecipeChoices(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  patch: AgentChoicePatch,
  accepted: AcceptedChoices,
  argumentsAuthored: boolean
): CurrentActionSelection {
  const selected = selectSourceControlActionRecipe(selection)
  const inheritsArgs = selection.source.scope === 'repo' && !selection.source.ownsArgs
  const choices = selectedSourceControlActionPreferences(selected, entry.agent) ?? {}
  const lowered = demoteDisplacedActionArgumentChoices(selected)
  const document = lowered === selected ? selection.current : trimActionArgumentDocument(lowered)
  const edited =
    inheritsArgs || selection.current.agentArgs === undefined || argumentsAuthored
      ? {
          ...selection.current,
          launchPreferences: editActionArgumentChoicePreferences(
            { ...selection.current, launchPreferences: selection.source.authoredPreferences },
            entry.agent,
            choices,
            patch,
            accepted.choices,
            inheritsArgs ? 'inherit' : 'default'
          )
        }
      : editActionArgumentChoices(
          { ...document, launchPreferences: selection.source.authoredPreferences },
          entry.agent,
          choices,
          patch,
          document.agentArgs ?? '',
          'default',
          accepted
        )
  return {
    current: {
      ...selection.current,
      ...(!inheritsArgs || argumentsAuthored
        ? {
            agentArgs:
              selection.current.agentArgs === undefined && !argumentsAuthored
                ? undefined
                : edited.agentArgs,
            argumentChoices: edited.argumentChoices
          }
        : {})
    },
    source: { ...selection.source, authoredPreferences: edited.launchPreferences }
  }
}

export function patchKeys(patch: AgentChoicePatch) {
  return [
    ...(patch.model !== undefined ? ['model'] : []),
    ...(patch.permissionMode !== undefined ? ['permissionMode'] : []),
    ...Object.keys(patch.options ?? {})
  ]
}

export function publishAccepted(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  result: AcceptedChoices,
  patch: AgentChoicePatch,
  argumentsAuthored: boolean,
  argumentsEffect?: string | null,
  rawSource = draft.pendingArguments ?? ''
): AgentPickerDraft {
  const authoredKeys = new Set(patchKeys(patch))
  const delegated = new Set(draft.delegated)
  const literalKeys = new Set(draft.literalKeys)
  for (const key of authoredKeys) {
    literalKeys.delete(key)
  }
  if (argumentsAuthored) {
    for (const occurrence of result.recognized) {
      if (patch.options?.[occurrence.key] !== null) {
        literalKeys.add(occurrence.key)
      }
    }
  }
  for (const key of authoredKeys) {
    const value = key === 'model' ? patch.model : patch.options?.[key]
    if (value === null) {
      delegated.add(key)
    } else {
      delegated.delete(key)
    }
  }
  if (patch.model === null) {
    for (const key of Object.keys(draft.choices.options ?? {})) {
      if (result.choices.options?.[key] === undefined) {
        delegated.add(key)
      }
    }
  }
  let choices = { ...draft.choices, options: { ...draft.choices.options } }
  if (patch.model !== undefined) {
    choices.model = patch.model ?? undefined
  }
  if (patch.permissionMode !== undefined) {
    choices.permissionMode = patch.permissionMode === 'default' ? undefined : patch.permissionMode
  }
  for (const [key, value] of Object.entries(patch.options ?? {})) {
    if (value === null) {
      delete choices.options[key]
    } else {
      choices.options[key] = value
    }
  }
  const { pendingArguments: _pending, ...accepted } = draft
  let selection = draft.recipeEdits?.selection
  if (selection && argumentsAuthored) {
    if (selection.source.scope === 'repo' && !selection.source.ownsArgs) {
      selection = {
        ...selection,
        current: { ...selection.current, argumentChoices: undefined }
      }
    }
    const raw = editSourceControlActionArguments(selection, rawSource)
    const document = reconcileActionArgumentDocumentTransaction(
      {
        ...raw.current,
        agentId: entry.agent,
        launchPreferences: raw.source.authoredPreferences
      },
      'arguments-edit',
      undefined,
      result
    ).recipe
    selection = {
      current: {
        ...raw.current,
        agentArgs: document.agentArgs,
        argumentChoices: document.argumentChoices
      },
      source: {
        ...raw.source,
        ...(raw.source.scope === 'repo' ? { ownsArgs: true } : {}),
        authoredPreferences: document.launchPreferences
      }
    }
    const { model: _model, ...ownPatch } = patch
    ownPatch.options = Object.fromEntries(
      Object.entries(patch.options ?? {}).filter(([key]) => key !== 'effort')
    )
    selection = editRecipeChoices(selection, entry, ownPatch, result, true)
  } else if (selection) {
    selection = editRecipeChoices(selection, entry, patch, result, false)
  }
  if (selection) {
    const recipe = selectSourceControlActionRecipe(selection)
    const bound = selectedSourceControlActionPreferences(recipe, entry.agent)
    choices = { ...bound, options: { ...bound?.options } }
    for (const occurrence of result.recognized) {
      if (authoredKeys.has(occurrence.key) && !argumentsAuthored) {
        continue
      }
      if (occurrence.key === 'model') {
        choices.model = occurrence.value
      } else if (occurrence.key === 'permissionMode') {
        choices.permissionMode = result.sourceChoices.permissionMode
      } else if (patch.options?.[occurrence.key] !== null) {
        choices.options[occurrence.key] = occurrence.value
      }
    }
    argumentsEffect = sourceControlActionExecutionArgs(recipe, entry.agent)
  }
  return {
    ...accepted,
    choices: {
      ...(choices.model ? { model: choices.model } : {}),
      ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {}),
      ...(Object.keys(choices.options).length ? { options: choices.options } : {})
    },
    delegated: [...delegated],
    literalKeys: [...literalKeys],
    ...(argumentsEffect !== undefined
      ? {
          arguments: argumentsEffect,
          ...(entry.ownerKey ? { argumentsOwner: entry.ownerKey } : {})
        }
      : {}),
    ...(selection
      ? {
          recipeEdits: {
            selection,
            changed: true,
            argumentsAuthored: argumentsAuthored || draft.recipeEdits!.argumentsAuthored
          }
        }
      : {})
  }
}
