import { parseExecutionHostId, type ExecutionHostId } from '../../execution-host'
import type { TextActionPickerCatalog } from './agent-launch-picker-text-action'
import { agentPickerLaunchChoices } from './agent-launch-picker-effective-choices'
import { agentPickerPanelArguments } from './agent-launch-picker-arguments'
import { agentPickerArgumentsKnown } from './agent-launch-picker-authority'

import { agentPickerOptions } from './agent-launch-picker-catalog'
import { projectAgentLaunchInputViews } from '../choices/agent-launch-profile'
import type { AgentChoicePatch, AgentDedicatedChoices } from '../choices/agent-launch-choices'
import {
  reconcileAgentChoiceArgs,
  reconcileAgentChoiceArgsDetailed
} from '../choices/agent-choice-reconciliation'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../agent-session/agent-session-wire'
import { orderAgentLaunchPickerAgents, type NewTabAgentMenuRow } from './agent-launch-picker-rows'
import type { TuiAgent } from '../catalog/tui-agent'
import type { CurrentActionSelection } from '../../source-control/ai/recipes/source-control-action-selection'

export type AgentPickerSurface = 'chat' | 'terminal'
export type AgentPickerDraftOwner = object
export type AgentPickerModel = AgentSessionModelOption & {
  isLegacy?: true
  /** Listed only by a matching search, or while it is the current choice. */
  hidden?: true
}
export type AgentPickerEntry = {
  textGeneration?: TextActionPickerCatalog
  agent: TuiAgent
  label: string
  description?: string
  aliases?: string[]
  rows: NewTabAgentMenuRow[]
  surfaces: AgentPickerSurface[]
  defaultSurface: AgentPickerSurface
  terminal: AgentDedicatedChoices
  structured: AgentDedicatedChoices
  arguments?: string | null
  catalog: AgentSessionModelCatalogResult
  coherentCatalog?: boolean
  catalogRead?: 'pending' | 'settled' | 'failed' | 'unsupported'
  ownerKey?: string
  draftTarget?: { key: string; worktreeId?: string; repoId?: string; executionHostId: string }
  /** The workspace the agent launches in, whose files and skills its first prompt can name. */
  worktreeId?: string
  defaultsPending?: boolean
  structuredDefaultsPending?: boolean
}
export type AgentPickerDraft = {
  agent: TuiAgent
  surface: AgentPickerSurface
  choices: AgentDedicatedChoices
  argumentsOwner?: string
  arguments?: string | null
  pendingArguments?: string
  delegated?: readonly string[]
  literalKeys?: readonly string[]
  textChanges?: readonly ('model' | 'effort')[]
  acceptedEdits?: { choices: AgentChoicePatch; arguments?: string | null }
  /** A folded sparse edit receipt; never part of a launch or persisted recipe. */
  recipeEdits?: {
    selection: CurrentActionSelection
    changed: boolean
    argumentsAuthored: boolean
  }
  /** The first prompt typed in the panel, set only on the launch: never part of a kept setup. */
  prompt?: string
}

export function agentPickerDraft(
  entry: AgentPickerEntry,
  surface = entry.defaultSurface
): AgentPickerDraft {
  return { agent: entry.agent, surface, choices: {}, arguments: undefined }
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

export function agentPickerLaunchInputs(draft: AgentPickerDraft, entry?: AgentPickerEntry) {
  const authorized = !entry || agentPickerArgumentsKnown(entry, draft)
  const current = entry ? agentPickerPanelArguments(entry, draft) : undefined
  const choices = { ...draft.choices, options: { ...draft.choices.options } }
  for (const occurrence of current?.context.occurrences ?? []) {
    if (!draft.literalKeys?.includes(occurrence.key)) {
      continue
    }
    if (occurrence.key === 'model') {
      delete choices.model
    } else if (occurrence.key === 'permissionMode') {
      delete choices.permissionMode
    } else {
      delete choices.options[occurrence.key]
    }
  }
  const result =
    current?.context.result ??
    reconcileAgentChoiceArgsDetailed({
      agent: draft.agent,
      userArgs: authorized ? (draft.arguments ?? '') : '',
      choices,
      mode: 'load',
      keys: new Set([
        'model',
        'permissionMode',
        ...Object.keys(choices.options ?? {}),
        ...agentPickerOptions(draft.agent, choices.model, 'terminal').map((option) => option.id)
      ])
    })
  return projectAgentLaunchInputViews(draft.agent, choices, result, {
    ...(authorized && draft.arguments !== undefined ? { agentArgs: draft.arguments } : {}),
    modelContext: entry?.terminal.model,
    sourceKeys: current?.context.literalKeys,
    permissionContext: entry?.terminal.permissionMode
  })
}

export function agentPickerFreshLaunchInputs(
  draft: AgentPickerDraft,
  destination: { surface: AgentPickerSurface; executionHostId: ExecutionHostId | undefined },
  entry?: AgentPickerEntry
) {
  if (
    destination.surface === 'terminal' &&
    parseExecutionHostId(destination.executionHostId)?.kind === 'runtime' &&
    draft.acceptedEdits?.arguments === undefined
  ) {
    // Why: choosing a control can materialize settings text without authoring Arguments.
    return agentPickerLaunchInputs({ ...draft, arguments: undefined })
  }
  return agentPickerLaunchInputs(draft, entry)
}

export function agentPickerButtonOrder(entry: AgentPickerEntry): AgentPickerSurface[] {
  return [
    ...entry.surfaces.filter((surface) => surface !== entry.defaultSurface),
    ...entry.surfaces.filter((surface) => surface === entry.defaultSurface)
  ]
}

export { type AgentPickerSetup } from './agent-launch-picker-search'

export { agentPickerEffectiveChoices } from './agent-launch-picker-effective-choices'

export { agentPickerSessionOptions } from '../choices/agent-launch-choices'

export function agentPickerEntriesFromRows(
  rows: readonly NewTabAgentMenuRow[],
  detected: readonly TuiAgent[],
  seed: (agent: TuiAgent) => Pick<AgentPickerEntry, 'terminal' | 'structured' | 'arguments'>,
  label: (agent: TuiAgent) => string,
  defaultAgent: TuiAgent | 'blank' | null | undefined
): AgentPickerEntry[] {
  // Why: rows are grouped by surface, so first appearance would rank every chat agent above every CLI one.
  return orderAgentLaunchPickerAgents(defaultAgent, [...new Set(rows.map((row) => row.agent))]).map(
    (agent) => {
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
    }
  )
}

export { agentPickerHydrationQueue } from './agent-launch-picker-rows'
