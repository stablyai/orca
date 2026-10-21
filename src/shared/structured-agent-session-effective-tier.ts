/** A model's standard tier, which every model runs. */
export const STANDARD_SERVICE_TIER = 'default'

/** What a tier runs as under a model: one the model doesn't list runs as standard, except a tier
 *  no listed model offers that the agent itself reports running (a configured one). Unknown model
 *  tiers leave it as is. */
export function effectiveServiceTier(input: {
  tier: string
  modelTiers: readonly string[] | undefined
  listedTiers: readonly string[]
  reported: boolean
}): string {
  const { tier, modelTiers } = input
  if (tier === STANDARD_SERVICE_TIER || !modelTiers || modelTiers.includes(tier)) {
    return tier
  }
  return input.reported && !input.listedTiers.includes(tier) ? tier : STANDARD_SERVICE_TIER
}

type TieredModel = { id: string; serviceTiers?: readonly { value: string }[] }
const modelTierValues = (model: TieredModel | undefined) =>
  model?.serviceTiers?.map((choice) => choice.value)

/** The tier a chat at rest runs under its saved model; one no model lists is the agent's configured tier. */
export function savedEffectiveServiceTier(
  saved: { model?: string; serviceTier?: string },
  models: readonly TieredModel[]
): string | undefined {
  return (
    saved.serviceTier &&
    effectiveServiceTier({
      tier: saved.serviceTier,
      modelTiers: saved.model
        ? modelTierValues(models.find((entry) => entry.id === saved.model))
        : undefined,
      listedTiers: models.flatMap((entry) => modelTierValues(entry) ?? []),
      reported: true
    })
  )
}
