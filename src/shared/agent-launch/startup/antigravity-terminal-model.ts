import { analyzeChoiceArgs } from '../choices/agent-choice-args-analysis'
import { removeOverriddenAgentSessionArgs } from '../../agent-session/options/agent-session-option-launch'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import { analyzeAgentChoiceArgs } from '../choices/agent-choice-args'
import { normalizeAntigravityModel } from '../../agent-session/options/antigravity-model-efforts'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export type AntigravityLaunchModels = readonly { id: string; label: string }[]
const OPAQUE_WARNING =
  "Antigravity: couldn't adjust model and effort in Arguments; using them unchanged."

/** Only rewrite choices whose original spans prove ownership; command overrides stay literal. */
export function normalizeAntigravityTerminalArgs(args: {
  generated: readonly string[]
  appliedValues: Record<string, SessionOptionValue>
  raw: readonly string[]
  rawText: string
  override?: string
  shell: AgentStartupShell
  models?: AntigravityLaunchModels
  explicitEffort?: boolean
}): { tokens: string[]; warning?: string; model?: string } {
  const original = analyzeAgentChoiceArgs('antigravity', args.rawText)
  const originalChoices = original.occurrences.filter(
    (entry) => entry.key === 'model' || entry.key === 'effort'
  )
  const originalIsOwned =
    originalChoices.every((entry) => entry.source) &&
    original.cut(originalChoices, 'delete') !== null
  const renderedRaw = args.raw.map((token) => quoteStartupArg(token, args.shell)).join(' ')
  const raw = analyzeChoiceArgs('antigravity', renderedRaw, [args.shell])
  const choices = raw.occurrences.filter((entry) => entry.key === 'model' || entry.key === 'effort')
  const parsedOverride = tokenizeStartupCommand(args.override ?? '', args.shell)
  const overrideText =
    parsedOverride.ok && parsedOverride.spans.length
      ? (args.override ?? '').slice(parsedOverride.spans[0].end).trim()
      : ''
  const override = analyzeAgentChoiceArgs('antigravity', overrideText)
  const pins = override.occurrences.filter(
    (entry) => entry.key === 'model' || entry.key === 'effort'
  )
  const otherGenerated = removeOverriddenAgentSessionArgs(
    'antigravity',
    { model: 'selected', effort: 'requested' },
    args.generated
  )
  const modelPin = pins.findLast((entry) => entry.key === 'model')
  const effortPin = pins.findLast((entry) => entry.key === 'effort')
  if (modelPin) {
    return {
      tokens: [...otherGenerated, ...args.raw],
      ...(args.explicitEffort || effortPin || choices.some((entry) => entry.key === 'effort')
        ? { warning: OPAQUE_WARNING }
        : {})
    }
  }
  const cutRaw = raw.cut(choices, 'delete')
  if (
    !originalIsOwned ||
    cutRaw === null ||
    choices.some((entry) => !entry.source) ||
    pins.some((entry) => !entry.source)
  ) {
    const rawOwnsModel = [...originalChoices, ...choices, ...pins].some(
      (entry) => entry.key === 'model'
    )
    const generated = rawOwnsModel
      ? otherGenerated
      : removeOverriddenAgentSessionArgs('antigravity', { effort: 'requested' }, args.generated)
    return {
      tokens: [...generated, ...args.raw],
      ...(!rawOwnsModel && typeof args.appliedValues.model === 'string'
        ? { model: args.appliedValues.model }
        : {}),
      warning: OPAQUE_WARNING
    }
  }
  const model =
    choices.findLast((entry) => entry.key === 'model')?.value ??
    (typeof args.appliedValues.model === 'string' ? args.appliedValues.model : undefined)
  const effort =
    effortPin?.value ??
    choices.findLast((entry) => entry.key === 'effort')?.value ??
    (typeof args.appliedValues.effort === 'string' ? args.appliedValues.effort : undefined)
  const normalized = normalizeAntigravityModel(model, effort, args.models)
  const remaining = tokenizeStartupCommand(cutRaw, args.shell)
  if (!remaining.ok) {
    return { tokens: [...otherGenerated, ...args.raw], warning: OPAQUE_WARNING }
  }
  return {
    tokens: [
      ...otherGenerated,
      ...(normalized.model ? ['--model', normalized.model] : []),
      ...remaining.tokens
    ],
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.warning &&
    (model ||
      args.explicitEffort ||
      effortPin ||
      (args.explicitEffort === undefined && choices.some((entry) => entry.key === 'effort')))
      ? { warning: effortPin ? OPAQUE_WARNING : normalized.warning }
      : {})
  }
}
