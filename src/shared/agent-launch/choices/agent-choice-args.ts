import { PERMISSION_LAUNCH_GRAMMARS } from '../permissions/agent-permission-args'
import { tokenizeStartupCommand, type AgentStartupShell } from '../startup/tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'
import { analyzeChoiceArgs, type ChoiceOccurrence } from './agent-choice-args-analysis'
import {
  composeAgentLaunchModel,
  type ResolvedSessionOptionLaunch
} from '../../agent-session/options/launch/agent-session-option-launch'
import type { AgentPermissionChoice } from '../permissions/tui-agent-permission-choice'

export type AgentChoicePublicationContext = {
  shell: AgentStartupShell
  generatedArgs: string
  launch: ResolvedSessionOptionLaunch
  permissionMode?: AgentPermissionChoice
}

/** Arbitrary raw and native splicing keep their all-grammar proof. */
export function analyzeAgentChoiceArgs(
  agent: TuiAgent,
  text: string,
  publication?: AgentChoicePublicationContext
) {
  const strict = analyzeChoiceArgs(agent, text, PERMISSION_LAUNCH_GRAMMARS)
  if (!publication) {
    return strict
  }
  const generated = analyzeChoiceArgs(agent, publication.generatedArgs, [publication.shell])
  const model = composeAgentLaunchModel(agent, publication.launch.appliedValues)
  const emitted = generated.occurrences.filter((entry) => {
    const value =
      entry.key === 'model'
        ? model
        : entry.key === 'permissionMode'
          ? publication.permissionMode
          : publication.launch.appliedValues[entry.key]
    return value !== undefined && String(value) === entry.value && typeof value === entry.valueType
  })
  const current = analyzeChoiceArgs(agent, text, [publication.shell], emitted)
  const generatedByKey = new Map<string, ChoiceOccurrence[]>()
  const counts = new Map<string, number>()
  const strictBySpan = new Map(
    strict.occurrences.map((entry) => [`${entry.key}:${entry.start}:${entry.end}`, entry])
  )
  for (const entry of emitted) {
    const existing = generatedByKey.get(entry.key) ?? []
    existing.push(entry)
    generatedByKey.set(entry.key, existing)
  }
  for (const entry of current.occurrences) {
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
  }
  const occurrences = current.occurrences.map((entry) => {
    const matching = generatedByKey.get(entry.key)
    const previous = strictBySpan.get(`${entry.key}:${entry.start}:${entry.end}`)
    const publicationOwned =
      entry.owned &&
      counts.get(entry.key) === 1 &&
      matching?.length === 1 &&
      matching[0].value === entry.value &&
      matching[0].valueType === entry.valueType &&
      generated.cut(matching) !== null
    return {
      ...entry,
      owned: previous?.owned ?? false,
      lift: previous?.lift ?? false,
      publicationOwned
    }
  })
  return {
    ...current,
    occurrences,
    publishedKeys: new Set(emitted.map((entry) => entry.key))
  }
}

/** Omission must remove every carrier without changing the meaning of unrelated arguments. */
export function withoutAgentEffortArgs(
  agent: TuiAgent,
  text: string,
  shell?: AgentStartupShell
): string | null {
  const grammars = shell ? [shell] : PERMISSION_LAUNCH_GRAMMARS
  const parsed = grammars.map((grammar) => ({
    grammar,
    parsed: tokenizeStartupCommand(text, grammar)
  }))
  if (parsed.some((entry) => !entry.parsed.ok)) {
    // A picker has no consuming shell yet; harmless text can wait for the host's proof.
    const valid = parsed.filter((entry) => entry.parsed.ok)
    return valid.length &&
      valid.every(({ grammar }) => {
        const candidate = analyzeChoiceArgs(agent, text, [grammar])
        return (
          !candidate.opaqueKeys.has('effort') &&
          !candidate.occurrences.some((entry) => entry.key === 'effort')
        )
      })
      ? text
      : null
  }
  const analysis = analyzeChoiceArgs(agent, text, grammars)
  const effort = analysis.occurrences.filter((entry) => entry.key === 'effort')
  if (analysis.opaqueKeys.has('effort') || effort.some((entry) => !entry.source)) {
    return null
  }
  const cleared = analysis.cut(effort)
  if (cleared === null) {
    return null
  }
  const remaining = analyzeChoiceArgs(agent, cleared, grammars)
  return remaining.opaqueKeys.has('effort') ||
    remaining.occurrences.some((entry) => entry.key === 'effort')
    ? null
    : cleared
}
