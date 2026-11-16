import type { AgentSessionExecutionOptions } from './protocol/agent-session-execution-options'
import { decodeStructuredAgentSessionOptionValue } from './selection/structured-agent-session-option-codec'
import {
  effectiveServiceTier,
  STANDARD_SERVICE_TIER
} from './reconciliation/structured-agent-session-effective-tier'

export const CODEX_MESSAGE_CONTROL_KEYS = [
  'model',
  'effort',
  'serviceTier',
  'personality',
  'interactionMode'
] as const

/** Copied from the bound live owner once; no catalog/session objects cross the writer port. */
export type CodexMessageCompilerInputs = {
  active: AgentSessionExecutionOptions
  activeInput: AgentSessionExecutionOptions
  defaults: AgentSessionExecutionOptions
  models: readonly { id: string; serviceTiers?: readonly string[]; fastServiceTier?: string }[]
  listedServiceTiers: readonly string[]
  reportedServiceTier?: string | null
}

export type StructuredMessageSteeringInputs =
  | { kind: 'other' }
  | { kind: 'codex-unavailable' }
  | { kind: 'codex'; compiler: CodexMessageCompilerInputs }

export function codexServiceTierForFastMode(
  encoded: string,
  fastServiceTier: string | undefined
): string {
  const fastMode = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  if (typeof fastMode !== 'boolean') {
    throw new Error('codex fast mode must be encoded as true or false')
  }
  return fastMode ? (fastServiceTier ?? 'fast') : STANDARD_SERVICE_TIER
}

export function normalizeCodexMessageOptions(
  input: CodexMessageCompilerInputs,
  supplied: Readonly<Record<string, string>>
): Record<string, string> {
  const options = { ...supplied }
  const model = input.models.find((entry) => entry.id === (options.model ?? input.active.model))
  const tier = options.serviceTier
  if (tier && model?.serviceTiers) {
    options.serviceTier = effectiveServiceTier({
      tier,
      modelTiers: model.serviceTiers,
      listedTiers: input.listedServiceTiers,
      reported: tier === input.reportedServiceTier
    })
  }
  return options
}

/** Sparse dispatch compilation and steering use the same data computation. */
export function compileCodexMessageOptions(
  input: CodexMessageCompilerInputs,
  choices: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const compiled: Record<string, string> = {}
  for (const key of CODEX_MESSAGE_CONTROL_KEYS) {
    if (choices[key] !== undefined) {
      compiled[key] = choices[key]
    }
  }
  if (choices.serviceTier === undefined && choices.fastMode !== undefined) {
    const model = input.models.find((entry) => entry.id === (compiled.model ?? input.active.model))
    compiled.serviceTier = codexServiceTierForFastMode(choices.fastMode, model?.fastServiceTier)
  }
  return normalizeCodexMessageOptions(input, compiled)
}

/** Compare retained input choices, without reinterpreting them through a later catalog. */
export function codexMessageInputOptions(
  choices: Readonly<Record<string, string | undefined>>,
  inherited: Readonly<Record<string, string>> = {},
  applied: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> {
  const next = { ...inherited }
  for (const key of ['model', 'effort', 'personality', 'serviceTier', 'interactionMode'] as const) {
    if (choices[key] !== undefined) {
      next[key] = choices[key]
    }
  }
  if (choices.serviceTier === undefined && choices.fastMode !== undefined) {
    const legacy = codexServiceTierForFastMode(choices.fastMode, undefined)
    const inheritedTier = inherited.serviceTier
    const tier =
      inheritedTier === 'priority' || inheritedTier === 'fast' ? inheritedTier : applied.serviceTier
    next.serviceTier = legacy === 'fast' && (tier === 'priority' || tier === 'fast') ? tier : legacy
  }
  return next
}

export function structuredMessageSteeringOptionsDiffer(
  input: StructuredMessageSteeringInputs,
  options: AgentSessionExecutionOptions | undefined
): boolean {
  if (input.kind === 'other') {
    return false
  }
  if (input.kind === 'codex-unavailable') {
    return false
  }
  const active = input.compiler.activeInput
  const next = codexMessageInputOptions(
    options ?? input.compiler.defaults,
    active,
    input.compiler.active
  )
  return CODEX_MESSAGE_CONTROL_KEYS.some(
    (key) => active[key] !== undefined && next[key] !== undefined && next[key] !== active[key]
  )
}
