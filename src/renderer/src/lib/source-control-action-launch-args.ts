// Why: a launch action stores a blank CLI-arguments field verbatim, but the launchers fall back to
// the agent's configured arguments only on `undefined` — an empty string beats that fallback and
// silently strips them (#19379). Blank means "no per-action override", so report it as absent.
export function sourceControlActionLaunchArgs(
  recipeAgentArgs: string | undefined
): string | undefined {
  return recipeAgentArgs === '' ? undefined : recipeAgentArgs
}
