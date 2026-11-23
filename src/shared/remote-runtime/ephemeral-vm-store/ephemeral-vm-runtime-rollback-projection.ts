import { featureIdentity, sortRuntimeFeatures } from './ephemeral-vm-runtime-feature-store'
import {
  hasEphemeralVmRecipeResult,
  RollbackEphemeralVmRuntimeRecordSchema,
  type EphemeralVmProvisionedRuntimeRecord,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'

/** Older builds require `recipeResult` on every record, so write-ahead records live in a sidecar they never read. */
export function partitionRuntimesForRollback(runtimes: readonly EphemeralVmRuntimeRecord[]): {
  rollback: EphemeralVmRuntimeRecord[]
  writeAhead: EphemeralVmRuntimeRecord[]
} {
  const rollback: EphemeralVmRuntimeRecord[] = []
  const writeAhead: EphemeralVmRuntimeRecord[] = []
  for (const runtime of runtimes) {
    if (hasEphemeralVmRecipeResult(runtime)) {
      rollback.push(projectRuntimeForRollback(runtime))
    } else {
      writeAhead.push(runtime)
    }
  }
  return { rollback, writeAhead }
}

export function projectRuntimeForRollback(
  runtime: EphemeralVmProvisionedRuntimeRecord
): EphemeralVmRuntimeRecord {
  const recipe = runtime.recipe
    ? (({ checkoutMode: _checkoutMode, ...rollbackRecipe }) => rollbackRecipe)(runtime.recipe)
    : undefined
  const recipeResult =
    runtime.recipeResult.schemaVersion === 2
      ? (({ checkoutMode: _checkoutMode, ...rollbackResult }) => ({
          ...rollbackResult,
          schemaVersion: 1 as const
        }))(runtime.recipeResult)
      : runtime.recipeResult
  return RollbackEphemeralVmRuntimeRecordSchema.parse({
    ...runtime,
    ...(recipe ? { recipe } : {}),
    recipeResult
  })
}

export function mergeRuntimeFeatures<T extends { id: string; recipeId: string; createdAt: number }>(
  existing: readonly T[],
  required: readonly T[]
): T[] {
  const merged = new Map(existing.map((entry) => [featureIdentity(entry), entry]))
  for (const entry of required) {
    merged.set(featureIdentity(entry), entry)
  }
  return sortRuntimeFeatures([...merged.values()])
}

export function runtimeFeatureListsEqual<
  T extends { id: string; recipeId: string; createdAt: number }
>(left: readonly T[], right: readonly T[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
