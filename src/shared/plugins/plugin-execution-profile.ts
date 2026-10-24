import { z } from 'zod'
import type { RefinementCtx } from 'zod'

/** Ordered from least to most authority; each profile may carry everything below it. */
export const PLUGIN_EXECUTION_PROFILES = [
  'data',
  'instructional',
  'sandboxed-ui',
  'trusted-worker'
] as const

export const pluginExecutionProfileSchema = z.enum(PLUGIN_EXECUTION_PROFILES)
export type PluginExecutionProfile = z.infer<typeof pluginExecutionProfileSchema>

type ExecutionSubject = {
  main?: string
  capabilities: readonly unknown[]
  contributes: {
    panels: readonly unknown[]
    commands: readonly unknown[]
    events: readonly unknown[]
    keybindings: readonly unknown[]
    vmRecipes: readonly unknown[]
    agents: readonly unknown[]
  }
}

function rank(profile: PluginExecutionProfile): number {
  return PLUGIN_EXECUTION_PROFILES.indexOf(profile)
}

export function pluginExecutionAllows(
  profile: PluginExecutionProfile,
  required: PluginExecutionProfile
): boolean {
  return rank(profile) >= rank(required)
}

/** Least profile that can run what a manifest declares; v1 manifests use this as their profile. */
export function derivePluginExecutionProfile(manifest: ExecutionSubject): PluginExecutionProfile {
  const c = manifest.contributes
  if (manifest.main !== undefined || c.events.length > 0) {
    return 'trusted-worker'
  }
  if (c.panels.length > 0) {
    return 'sandboxed-ui'
  }
  if (
    c.commands.length > 0 ||
    c.keybindings.length > 0 ||
    c.vmRecipes.length > 0 ||
    c.agents.length > 0 ||
    manifest.capabilities.length > 0
  ) {
    return 'instructional'
  }
  return 'data'
}

export function pluginExecutionProfile(
  manifest: ExecutionSubject & { execution?: PluginExecutionProfile }
): PluginExecutionProfile {
  return manifest.execution ?? derivePluginExecutionProfile(manifest)
}

/** A v2 manifest declares its profile, so contributions beyond it fail validation. */
export function validatePluginExecutionProfile(
  manifest: ExecutionSubject & { execution: PluginExecutionProfile },
  ctx: RefinementCtx
): void {
  const required = derivePluginExecutionProfile(manifest)
  if (!pluginExecutionAllows(manifest.execution, required)) {
    ctx.addIssue({
      code: 'custom',
      path: ['execution'],
      message: `${manifest.execution} cannot carry contributions that need ${required}`
    })
  }
  if (manifest.execution === 'trusted-worker' && manifest.main === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['main'],
      message: 'trusted-worker requires a Node entry'
    })
  }
}
