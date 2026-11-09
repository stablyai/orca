import type { OrcaVmRecipe, OrcaVmRecipeLifecycleMode } from './orca-yaml-hook-types'
import type {
  EphemeralVmRecipeContext,
  EphemeralVmRecipeStartArgs
} from './ephemeral-vm-recipe-runner'
import { runRecipeCommand, type ProcessRunResult } from './ephemeral-vm-recipe-process'
import { getEphemeralVmRecipeResultSchemaVersion } from './ephemeral-vm-recipe-checkout-mode'
import {
  ephemeralVmExitFailure,
  ephemeralVmTimeoutFailure,
  type EphemeralVmFailure
} from './ephemeral-vm-failure-copy'
import { getEphemeralVmRecipeTimeoutSeconds } from './ephemeral-vm-recipe-timeouts'

type RecipeStepArgs = Pick<
  EphemeralVmRecipeStartArgs,
  | 'recipe'
  | 'repoPath'
  | 'env'
  | 'maxCaptureBytes'
  | 'signal'
  | 'onSpawn'
  | 'onStdout'
  | 'onStderr'
  | 'spawnCommand'
>

export function runRecipeStep(
  args: RecipeStepArgs,
  mode: OrcaVmRecipeLifecycleMode,
  command: string,
  context: EphemeralVmRecipeContext,
  stdin?: string
): Promise<ProcessRunResult> {
  return runRecipeCommand({
    command,
    repoPath: args.repoPath,
    context,
    mode,
    resultSchemaVersion: getEphemeralVmRecipeResultSchemaVersion(args.recipe),
    ...(stdin === undefined ? {} : { stdin }),
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onSpawn: args.onSpawn,
    timeoutMs: toTimeoutMs(getEphemeralVmRecipeTimeoutSeconds(args.recipe, mode)),
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })
}

export function getRecipeStepFailure(
  recipe: OrcaVmRecipe,
  mode: 'create' | 'suspend' | 'resume',
  result: ProcessRunResult
): EphemeralVmFailure | null {
  if (result.timedOut) {
    return ephemeralVmTimeoutFailure(mode, getEphemeralVmRecipeTimeoutSeconds(recipe, mode) ?? 0)
  }
  if (result.exitCode !== 0) {
    return ephemeralVmExitFailure(mode === 'create' ? 'recipe' : mode, result.exitCode)
  }
  return null
}

function toTimeoutMs(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000
}
