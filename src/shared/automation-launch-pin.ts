/** The launch choice an automation pins for every one of its runs. */
export type AutomationLaunchPin = {
  model: string
  effort?: string
}

/**
 * The pin as the launch surfaces want it, or null when the automation takes the
 * agent default. Effort rides along only with a model, because every surface
 * that consumes this — session options, launch preferences, run history — reads
 * an effort with nothing to apply it to as no pin at all.
 */
export function automationLaunchPin(source: {
  model?: string | null
  effort?: string | null
}): AutomationLaunchPin | null {
  if (!source.model) {
    return null
  }
  return {
    model: source.model,
    ...(source.effort ? { effort: source.effort } : {})
  }
}
