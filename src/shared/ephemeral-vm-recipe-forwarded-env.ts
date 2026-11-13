import { buildRecipeInheritedEnv, isRecipeCredentialEnvName } from './ephemeral-vm-recipe-env'

/** Names only: the env a recipe's scripts inherit (passEnv-narrowed or whole); values never leave main. */
export type RecipeForwardedEnvSummary = {
  count: number
  /** Sorted names that look like credentials (isRecipeCredentialEnvName). */
  keyLike: string[]
  /** Every other forwarded name, sorted. */
  other: string[]
  /** True when the recipe's passEnv narrowed the env; false means this computer's whole env. */
  narrowed: boolean
}

/** Summarizes what buildRecipeEnv would inherit: the whole env, or only what `passEnv` allows. */
export function summarizeRecipeForwardedEnv(
  source: NodeJS.ProcessEnv,
  passEnv?: readonly string[],
  platform: NodeJS.Platform = process.platform
): RecipeForwardedEnvSummary {
  const env = buildRecipeInheritedEnv(source, passEnv, platform)
  const names = Object.keys(env)
    .filter((name) => name.length > 0 && env[name] !== undefined)
    .sort((a, b) => a.localeCompare(b))
  return {
    count: names.length,
    keyLike: names.filter(isRecipeCredentialEnvName),
    other: names.filter((name) => !isRecipeCredentialEnvName(name)),
    narrowed: passEnv !== undefined
  }
}
