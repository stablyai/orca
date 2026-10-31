import { analyzeAgentChoiceArgs } from './agent-choice-args'
import {
  agentPickerArgumentsKnown,
  agentPickerArgumentsText
} from './agent-launch-picker-authority'
export {
  agentPickerArgumentsKnown,
  agentPickerArgumentsText
} from './agent-launch-picker-authority'
export {
  agentPickerChoiceSeeds,
  type AgentPickerDefaultSettings
} from './agent-launch-picker-defaults'
import { agentPickerOptions } from './agent-launch-picker-catalog'
export {
  agentPickerOptions,
  agentPickerModels,
  agentPickerEntryOptions,
  agentPickerPermissions
} from './agent-launch-picker-catalog'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import type { AgentChoicePatch, AgentDedicatedChoices } from './agent-launch-choices'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import type { AgentSessionModelCatalogResult, AgentSessionModelOption } from './agent-session-wire'
import type { NewTabAgentMenuRow } from './agent-launch-picker-rows'
import type { TuiAgent } from './tui-agent'

export type AgentPickerSurface = 'chat' | 'terminal'
export type AgentPickerModel = AgentSessionModelOption & { isLegacy?: true; hidden?: true }
export type AgentPickerEntry = {
  agent: TuiAgent
  label: string
  aliases?: string[]
  rows: NewTabAgentMenuRow[]
  surfaces: AgentPickerSurface[]
  defaultSurface: AgentPickerSurface
  terminal: AgentDedicatedChoices
  structured: AgentDedicatedChoices
  arguments?: string | null
  catalog: AgentSessionModelCatalogResult
  ownerKey?: string
  defaultsPending?: boolean
  structuredDefaultsPending?: boolean
}
export type AgentPickerDraft = {
  agent: TuiAgent
  surface: AgentPickerSurface
  choices: AgentDedicatedChoices
  argumentsOwner?: string
  arguments?: string | null
}
export type AgentPickerSetup = {
  entry: AgentPickerEntry
  model: AgentPickerModel
  choices: AgentDedicatedChoices
  label: string
}

export function agentPickerDraft(
  entry: AgentPickerEntry,
  surface = entry.defaultSurface
): AgentPickerDraft {
  return { agent: entry.agent, surface, choices: {}, arguments: undefined }
}

export function agentPickerEffectiveChoices(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): AgentDedicatedChoices {
  const defaults =
    draft.surface === 'chat'
      ? entry.structured
      : draft.arguments !== undefined
        ? entry.terminal
        : reconcileAgentChoiceArgs({
            agent: entry.agent,
            userArgs: entry.arguments ?? '',
            choices: entry.terminal,
            mode: 'load',
            keys: new Set([
              'model',
              'permissionMode',
              ...agentPickerOptions(entry.agent, entry.terminal.model, 'terminal').map(
                (option) => option.id
              )
            ])
          }).choices
  return resolveAgentChoiceLayers({
    agent: entry.agent,
    defaults,
    explicit: agentPickerLaunchChoices(draft).choices,
    userArgs:
      draft.surface === 'chat'
        ? undefined
        : draft.arguments === undefined
          ? entry.arguments
          : draft.arguments,
    argumentOwner: draft.arguments === undefined ? 'defaults' : 'launch'
  })
}

export function editAgentPickerDraft(
  draft: AgentPickerDraft,
  patch: AgentChoicePatch
): AgentPickerDraft {
  const keys = new Set([
    ...(patch.model !== undefined ? ['model'] : []),
    ...Object.keys(patch.options ?? {})
  ])
  const result = reconcileAgentChoiceArgs({
    agent: draft.agent,
    userArgs: '',
    choices: draft.choices,
    mode: 'choice-edit',
    keys,
    patch
  })
  // Terminal text can clear its own flags without making its other lifted values shared choices.
  const argumentsEdit =
    draft.arguments === undefined
      ? undefined
      : reconcileAgentChoiceArgs({
          agent: draft.agent,
          userArgs: draft.arguments ?? '',
          choices: agentPickerLaunchChoices({ ...draft, surface: 'terminal' }).choices,
          mode: 'choice-edit',
          keys,
          patch
        })
  return {
    ...draft,
    choices: result.choices,
    ...(argumentsEdit ? { arguments: argumentsEdit.userArgs || null } : {})
  }
}

export function editAgentPickerArguments(draft: AgentPickerDraft, text: string): AgentPickerDraft {
  return { ...draft, arguments: text || null }
}

function agentPickerLaunchChoices(draft: AgentPickerDraft) {
  if (draft.surface !== 'terminal' || draft.arguments === undefined) {
    return { choices: draft.choices, userArgs: draft.arguments }
  }
  const result = reconcileAgentChoiceArgs({
    agent: draft.agent,
    userArgs: draft.arguments ?? '',
    choices: draft.choices,
    mode: 'arguments-edit',
    keys: new Set([
      'model',
      'permissionMode',
      ...Object.keys(draft.choices.options ?? {}),
      ...agentPickerOptions(draft.agent, draft.choices.model, 'terminal').map((option) => option.id)
    ])
  })
  return result
}

export function agentPickerLaunchInputs(draft: AgentPickerDraft, entry?: AgentPickerEntry) {
  const authorized = !entry || agentPickerArgumentsKnown(entry, draft)
  const { choices: launchChoices, userArgs } = agentPickerLaunchChoices(
    authorized ? draft : { ...draft, arguments: undefined }
  )
  const choices = {
    ...launchChoices,
    ...(launchChoices.options ? { options: { ...launchChoices.options } } : {})
  }
  const text = entry ? agentPickerArgumentsText(entry, draft) : draft.arguments
  if (
    text &&
    analyzeAgentChoiceArgs(draft.agent, text).opaqueKeys.has('fastMode') &&
    choices.options
  ) {
    choices.options = Object.fromEntries(
      Object.entries(choices.options).filter(([key]) => key !== 'fastMode')
    )
  }
  // The existing dispatcher treats an Arguments override as the complete terminal profile.
  const sessionOptions = agentPickerSessionOptions(choices)
  return {
    ...(Object.keys(sessionOptions).length ? { sessionOptions } : {}),
    ...(draft.surface === 'terminal' && userArgs !== undefined
      ? {
          agentArgs: projectAgentLaunchProfile(draft.agent, undefined, {
            target: 'terminal',
            userArgs: userArgs ?? '',
            choices: {
              ...(entry?.terminal.permissionMode
                ? { permissionMode: entry.terminal.permissionMode }
                : {}),
              ...choices
            }
          }).args
        }
      : {})
  }
}

export function agentPickerButtonOrder(entry: AgentPickerEntry): AgentPickerSurface[] {
  return [
    ...entry.surfaces.filter((surface) => surface !== entry.defaultSurface),
    ...entry.surfaces.filter((surface) => surface === entry.defaultSurface)
  ]
}

export { searchAgentPickerSetups } from './agent-launch-picker-search'

export function agentPickerSessionOptions(choices: AgentDedicatedChoices): Record<string, string> {
  return {
    ...choices.options,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {})
  }
}

export function agentPickerEntriesFromRows(
  rows: readonly NewTabAgentMenuRow[],
  detected: readonly TuiAgent[],
  seed: (agent: TuiAgent) => Pick<AgentPickerEntry, 'terminal' | 'structured' | 'arguments'>,
  label: (agent: TuiAgent) => string
): AgentPickerEntry[] {
  return [...new Set(rows.map((row) => row.agent))].map((agent) => {
    const own = rows.filter((row) => row.agent === agent)
    const chatDefault = own.some((row) => row.kind === 'chat')
    const chat = chatDefault || own.some((row) => row.kind === 'cli' && row.chat)
    return {
      agent,
      label: label(agent),
      rows: own,
      surfaces: [
        ...(chat ? ['chat' as const] : []),
        ...(detected.includes(agent) ? ['terminal' as const] : [])
      ],
      defaultSurface: chatDefault ? 'chat' : 'terminal',
      ...seed(agent),
      catalog: { origin: 'unknown' }
    }
  })
}

export function agentPickerHydrationQueue(
  entries: readonly AgentPickerEntry[],
  selected: () => TuiAgent | undefined
): () => number | undefined {
  const pending = new Set(entries.flatMap((entry, index) => (entry.surfaces.length ? [index] : [])))
  return () => {
    const preferred = entries.findIndex((entry) => entry.agent === selected())
    const index = pending.has(preferred) ? preferred : pending.values().next().value
    if (index !== undefined) {
      pending.delete(index)
    }
    return index
  }
}
