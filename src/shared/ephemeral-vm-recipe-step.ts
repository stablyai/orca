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
import {
  getEphemeralVmRecipeStepProvider,
  type RecipeStepProviderResult
} from './ephemeral-vm-recipe-step-providers'

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
  if (args.recipe.provider) {
    return runProviderStep(args, mode, context, stdin)
  }
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

async function runProviderStep(
  args: RecipeStepArgs,
  mode: OrcaVmRecipeLifecycleMode,
  context: EphemeralVmRecipeContext,
  stdin: string | undefined
): Promise<RecipeStepProviderResult> {
  const provider = getEphemeralVmRecipeStepProvider(args.recipe.provider!)
  if (!provider) {
    return {
      stdout: '',
      stderr: 'This provider is not available in this build.\n',
      exitCode: 1,
      signal: null
    }
  }
  const timeoutMs = toTimeoutMs(getEphemeralVmRecipeTimeoutSeconds(args.recipe, mode))
  const timeout = timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs)
  const signals = [args.signal, timeout].filter(
    (s): s is AbortSignal => s !== undefined && s !== null
  )
  args.onSpawn?.()
  try {
    return await provider({
      mode,
      repoPath: args.repoPath,
      context,
      ...(stdin === undefined ? {} : { stdin }),
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
      onStderr: args.onStderr
    })
  } catch (error) {
    if (timeout?.aborted) {
      return { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: true }
    }
    if (args.signal?.aborted) {
      return { stdout: '', stderr: '', exitCode: null, signal: null, aborted: true }
    }
    return {
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1,
      signal: null
    }
  }
}

export function getRecipeStepFailure(
  recipe: OrcaVmRecipe,
  mode: 'create' | 'suspend' | 'resume',
  result: RecipeStepProviderResult
): EphemeralVmFailure | null {
  if (result.failure) {
    return result.failure
  }
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
