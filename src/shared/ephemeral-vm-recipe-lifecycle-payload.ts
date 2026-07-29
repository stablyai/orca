import type { EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import { quoteShellToken } from './ephemeral-vm-recipe-process'
import type { OrcaVmRecipe } from './types'

export type EphemeralVmRecipeLifecycleMode = 'suspend' | 'resume' | 'destroy'

export type EphemeralVmRecipeCleanupPayload = {
  schemaVersion: 1
  mode: EphemeralVmRecipeLifecycleMode
  recipeId: string
  instanceId?: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  recipeResult: EphemeralVmRecipeResult
}

export function buildEphemeralVmRecipeCleanupPayload(args: {
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): EphemeralVmRecipeCleanupPayload {
  return buildEphemeralVmRecipeLifecyclePayload({ ...args, mode: 'destroy' })
}

export function buildEphemeralVmRecipeLifecyclePayload(args: {
  mode: EphemeralVmRecipeLifecycleMode
  recipe: Pick<OrcaVmRecipe, 'id'>
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): EphemeralVmRecipeCleanupPayload {
  return {
    schemaVersion: 1,
    mode: args.mode,
    recipeId: args.recipe.id,
    instanceId: args.context.instanceId,
    projectId: args.context.projectId,
    workspaceId: args.context.workspaceId,
    workspaceName: args.context.workspaceName,
    recipeResult: args.recipeResult
  }
}

export function buildEphemeralVmRecipeCleanupCommand(args: {
  destroyCommand: string
  payload: EphemeralVmRecipeCleanupPayload
}): string {
  const payloadBase64 = Buffer.from(`${JSON.stringify(args.payload)}\n`, 'utf8').toString('base64')
  return [
    'node',
    '-e',
    quoteShellToken(
      `process.stdout.write(Buffer.from(${JSON.stringify(payloadBase64)}, 'base64').toString('utf8'))`
    ),
    '|',
    args.destroyCommand
  ].join(' ')
}
