import { z } from 'zod'
import { ORCA_VM_RECIPE_ID_PATTERN, ORCA_VM_RECIPE_ID_RULE } from '../orca-yaml'
import type { OrcaVmRecipe } from '../orca-yaml-hook-types'
import { machineProviderCommandSchema } from '../machine-provider-command'

const recipeCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(32 * 1024)
  .refine((value) => !value.includes('\0'), 'must not contain NUL bytes')

const recipeIdSchema = z.string().regex(ORCA_VM_RECIPE_ID_PATTERN, ORCA_VM_RECIPE_ID_RULE)
const recipeNameSchema = z.string().trim().min(1).max(128)
const recipeDescriptionSchema = z.string().trim().min(1).max(1024)

const pluginVmRecipeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: recipeIdSchema,
    name: recipeNameSchema,
    description: recipeDescriptionSchema.optional(),
    checkoutMode: z.enum(['orca-worktree', 'provisioned-root']).optional(),
    create: recipeCommandSchema,
    suspend: recipeCommandSchema.optional(),
    resume: recipeCommandSchema.optional(),
    destroy: z.union([recipeCommandSchema, z.literal('none')]).optional()
  })
  .strict()
  .superRefine((recipe, ctx) => {
    if (Boolean(recipe.suspend) !== Boolean(recipe.resume)) {
      ctx.addIssue({
        code: 'custom',
        path: recipe.suspend ? ['resume'] : ['suspend'],
        message: 'suspend and resume must be declared together'
      })
    }
  })

// Why a new schemaVersion: v1 parsers reject it, so older Orca refuses the plugin cleanly.
const pluginMachineProviderArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: recipeIdSchema,
    name: recipeNameSchema,
    description: recipeDescriptionSchema.optional(),
    machines: z.object({ command: machineProviderCommandSchema }).strict()
  })
  .strict()

export type PluginMachineProvider = {
  id: string
  name: string
  description?: string
  command: string[]
}

export type PluginVmRecipeArtifact =
  | { kind: 'recipe'; recipe: OrcaVmRecipe }
  | { kind: 'machine-provider'; provider: PluginMachineProvider }

export type PluginVmRecipeCommand = {
  phase: 'create' | 'suspend' | 'resume' | 'destroy'
  command: string
}

export function pluginVmRecipeArtifactId(artifact: PluginVmRecipeArtifact): string {
  return artifact.kind === 'recipe' ? artifact.recipe.id : artifact.provider.id
}

export function parsePluginVmRecipeArtifact(raw: string): PluginVmRecipeArtifact {
  const json: unknown = JSON.parse(raw)
  const schemaVersion =
    typeof json === 'object' && json !== null && 'schemaVersion' in json
      ? json.schemaVersion
      : undefined
  if (schemaVersion === 2) {
    const parsed = pluginMachineProviderArtifactSchema.parse(json)
    return {
      kind: 'machine-provider',
      provider: {
        id: parsed.id,
        name: parsed.name,
        ...(parsed.description ? { description: parsed.description } : {}),
        command: parsed.machines.command
      }
    }
  }
  const parsed = pluginVmRecipeArtifactSchema.parse(json)
  const destroyDisabled = parsed.destroy === 'none'
  return {
    kind: 'recipe',
    recipe: {
      id: parsed.id,
      name: parsed.name,
      create: parsed.create,
      ...(parsed.checkoutMode ? { checkoutMode: parsed.checkoutMode } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.suspend ? { suspend: parsed.suspend } : {}),
      ...(parsed.resume ? { resume: parsed.resume } : {}),
      ...(parsed.destroy && !destroyDisabled ? { destroy: parsed.destroy } : {}),
      ...(destroyDisabled ? { destroyDisabled: true } : {})
    }
  }
}

export function listPluginVmRecipeCommands(recipe: OrcaVmRecipe): PluginVmRecipeCommand[] {
  return [
    { phase: 'create', command: recipe.create },
    ...(recipe.suspend ? [{ phase: 'suspend' as const, command: recipe.suspend }] : []),
    ...(recipe.resume ? [{ phase: 'resume' as const, command: recipe.resume }] : []),
    ...(recipe.destroy
      ? [{ phase: 'destroy' as const, command: recipe.destroy }]
      : recipe.destroyDisabled
        ? [{ phase: 'destroy' as const, command: 'none' }]
        : [])
  ]
}
