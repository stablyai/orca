import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../native-chat-session-options'
import { isFastServiceTier } from '../../../agent-session/options/model-catalog/structured-agent-session-discovered-model'

const STANDARD_TIER = 'default'

export type SessionSpeedTiers = {
  standard: SessionOptionSelectChoice
  tiers: SessionOptionSelectChoice[]
}

/** Standard plus the other tiers, or null when the select is not a speed choice with any. */
export function speedButtonTiers(descriptor: SessionOptionDescriptor): SessionSpeedTiers | null {
  if (descriptor.id !== 'serviceTier' || descriptor.kind.type !== 'select') {
    return null
  }
  const standard = descriptor.kind.choices.find((choice) => choice.value === STANDARD_TIER)
  const tiers = descriptor.kind.choices.filter((choice) => choice.value !== STANDARD_TIER)
  return standard && tiers.length > 0 ? { standard, tiers } : null
}

/** A lone Fast tier toggles like Claude's Fast; Flex and several tiers are picked from a list. */
export function loneFastTier(
  tiers: readonly SessionOptionSelectChoice[]
): SessionOptionSelectChoice | undefined {
  return tiers.length === 1 && isFastServiceTier(tiers[0]) ? tiers[0] : undefined
}
