// In-process lifecycle steps for built-in providers (Orca Cloud). They answer exactly what a recipe
// process would — stdout JSON, stderr progress, an exit code — so records, timeouts, pairing reuse
// and failure copy keep one path.
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import type { ProcessRunResult } from './ephemeral-vm-recipe-process'
import type { EphemeralVmFailure } from './ephemeral-vm-failure-copy'
import type { OrcaVmRecipeLifecycleMode, OrcaVmRecipeProviderId } from './orca-yaml-hook-types'

export type RecipeStepProviderResult = ProcessRunResult & {
  /** A catalogued failure that replaces the generic "exited with code" copy. */
  failure?: EphemeralVmFailure
}

export type RecipeStepProvider = (step: {
  mode: OrcaVmRecipeLifecycleMode
  repoPath: string
  context: EphemeralVmRecipeContext
  /** The lifecycle payload a recipe would read on stdin (suspend/resume/destroy). */
  stdin?: string
  signal?: AbortSignal
  onStderr?: (chunk: string) => void
}) => Promise<RecipeStepProviderResult>

const providers = new Map<OrcaVmRecipeProviderId, RecipeStepProvider>()

export function registerEphemeralVmRecipeStepProvider(
  id: OrcaVmRecipeProviderId,
  provider: RecipeStepProvider
): () => void {
  providers.set(id, provider)
  return () => {
    if (providers.get(id) === provider) {
      providers.delete(id)
    }
  }
}

export function getEphemeralVmRecipeStepProvider(
  id: OrcaVmRecipeProviderId
): RecipeStepProvider | null {
  return providers.get(id) ?? null
}
