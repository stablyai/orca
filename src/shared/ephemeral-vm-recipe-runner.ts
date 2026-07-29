import type { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { OrcaVmRecipe } from './types'
import { parseEphemeralVmRecipeResult, type EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'
import {
  buildEphemeralVmRecipeCleanupPayload,
  buildEphemeralVmRecipeLifecyclePayload
} from './ephemeral-vm-recipe-lifecycle-payload'

export {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload,
  type EphemeralVmRecipeCleanupPayload
} from './ephemeral-vm-recipe-lifecycle-payload'

export type EphemeralVmRecipeContext = {
  instanceId?: string
  recipeId: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  repoPath: string
  repoUrl?: string
  branch?: string
  ref?: string
  orcaVersion?: string
}

export type EphemeralVmRecipeStartArgs = {
  recipe: OrcaVmRecipe
  repoPath: string
  context?: Partial<Omit<EphemeralVmRecipeContext, 'recipeId' | 'repoPath'>>
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
}

export type EphemeralVmRecipeStartSuccess = {
  ok: true
  context: EphemeralVmRecipeContext
  result: EphemeralVmRecipeResult
  stdout: string
  stderr: string
}

export type EphemeralVmRecipeStartFailure = {
  ok: false
  context: EphemeralVmRecipeContext
  error: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export type EphemeralVmRecipeStartResult =
  | EphemeralVmRecipeStartSuccess
  | EphemeralVmRecipeStartFailure

export type EphemeralVmRecipeCleanupArgs = {
  recipe: OrcaVmRecipe
  repoPath: string
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
}

export type EphemeralVmRecipeLifecycleArgs = EphemeralVmRecipeCleanupArgs

export type EphemeralVmRecipeCleanupResult = {
  ok: boolean
  skipped: boolean
  error?: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export type EphemeralVmRecipeResumeResult =
  | (EphemeralVmRecipeStartSuccess & { skipped: false })
  | (EphemeralVmRecipeStartFailure & { skipped: false })
  | {
      ok: true
      skipped: true
      context: EphemeralVmRecipeContext
      stdout: string
      stderr: string
    }

export async function runEphemeralVmRecipeStart(
  args: EphemeralVmRecipeStartArgs
): Promise<EphemeralVmRecipeStartResult> {
  validateRepoPath(args.repoPath)
  const context = buildRecipeContext(args.recipe, args.repoPath, args.context)
  const processResult = await runRecipeCommand({
    command: args.recipe.create,
    repoPath: args.repoPath,
    context,
    mode: 'create',
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })

  if (processResult.exitCode !== 0) {
    return {
      ok: false,
      context,
      error: `Recipe exited with code ${processResult.exitCode ?? 'unknown'}.`,
      ...processResult
    }
  }

  const parsed = parseEphemeralVmRecipeResult(processResult.stdout)
  if (!parsed.ok) {
    return {
      ok: false,
      context,
      error: parsed.error,
      ...processResult
    }
  }

  return {
    ok: true,
    context,
    result: parsed.result,
    stdout: processResult.stdout,
    stderr: processResult.stderr
  }
}

export async function runEphemeralVmRecipeCleanup(
  args: EphemeralVmRecipeCleanupArgs
): Promise<EphemeralVmRecipeCleanupResult> {
  validateRepoPath(args.repoPath)
  if (args.recipe.destroyDisabled || !args.recipe.destroy) {
    return { ok: true, skipped: true, stdout: '', stderr: '', exitCode: null, signal: null }
  }

  const payload = buildEphemeralVmRecipeCleanupPayload(args)
  const processResult = await runRecipeCommand({
    command: args.recipe.destroy,
    repoPath: args.repoPath,
    context: args.context,
    mode: 'destroy',
    stdin: `${JSON.stringify(payload)}\n`,
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })

  if (processResult.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      error: `Destroy exited with code ${processResult.exitCode ?? 'unknown'}.`,
      ...processResult
    }
  }

  return { ok: true, skipped: false, ...processResult }
}

export async function runEphemeralVmRecipeSuspend(
  args: EphemeralVmRecipeLifecycleArgs
): Promise<EphemeralVmRecipeCleanupResult> {
  validateRepoPath(args.repoPath)
  if (!args.recipe.suspend) {
    return { ok: true, skipped: true, stdout: '', stderr: '', exitCode: null, signal: null }
  }

  const payload = buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'suspend' })
  const processResult = await runRecipeCommand({
    command: args.recipe.suspend,
    repoPath: args.repoPath,
    context: args.context,
    mode: 'suspend',
    stdin: `${JSON.stringify(payload)}\n`,
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })

  if (processResult.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      error: `Suspend exited with code ${processResult.exitCode ?? 'unknown'}.`,
      ...processResult
    }
  }

  return { ok: true, skipped: false, ...processResult }
}

export async function runEphemeralVmRecipeResume(
  args: EphemeralVmRecipeLifecycleArgs
): Promise<EphemeralVmRecipeResumeResult> {
  validateRepoPath(args.repoPath)
  if (!args.recipe.resume) {
    return {
      ok: true,
      skipped: true,
      context: args.context,
      stdout: '',
      stderr: ''
    }
  }

  const payload = buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'resume' })
  const processResult = await runRecipeCommand({
    command: args.recipe.resume,
    repoPath: args.repoPath,
    context: args.context,
    mode: 'resume',
    stdin: `${JSON.stringify(payload)}\n`,
    env: args.env,
    maxCaptureBytes: args.maxCaptureBytes,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr,
    spawnCommand: args.spawnCommand
  })

  if (processResult.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      context: args.context,
      error: `Resume exited with code ${processResult.exitCode ?? 'unknown'}.`,
      ...processResult
    }
  }

  const parsed = parseEphemeralVmRecipeResult(processResult.stdout)
  if (!parsed.ok) {
    return {
      ok: false,
      skipped: false,
      context: args.context,
      error: parsed.error,
      ...processResult
    }
  }

  return {
    ok: true,
    skipped: false,
    context: args.context,
    result: parsed.result,
    stdout: processResult.stdout,
    stderr: processResult.stderr
  }
}

function buildRecipeContext(
  recipe: OrcaVmRecipe,
  repoPath: string,
  context: EphemeralVmRecipeStartArgs['context'] = {}
): EphemeralVmRecipeContext {
  return {
    ...context,
    instanceId: context.instanceId ?? `orca-${randomUUID()}`,
    recipeId: recipe.id,
    repoPath
  }
}

function validateRepoPath(repoPath: string): void {
  const stat = statSync(repoPath)
  if (!stat.isDirectory()) {
    throw new Error(`Recipe repo path is not a directory: ${repoPath}`)
  }
}
