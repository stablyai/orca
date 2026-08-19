import { featureIdentity } from './ephemeral-vm-runtime-feature-store'
import {
  RollbackEphemeralVmRuntimeRecordSchema,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'

export function projectRuntimeForRollback(
  runtime: EphemeralVmRuntimeRecord
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
  return [...merged.values()].sort((left, right) =>
    featureIdentity(left).localeCompare(featureIdentity(right))
  )
}

export function runtimeFeatureListsEqual<
  T extends { id: string; recipeId: string; createdAt: number }
>(left: readonly T[], right: readonly T[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
