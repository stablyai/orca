import { z } from 'zod'
import type { RefinementCtx } from 'zod'
import {
  PLUGIN_CONTRIBUTION_POINT_POLICY,
  PLUGIN_CONTRIBUTION_POINTS,
  type PluginContributionPoint
} from './plugin-contribution-points'

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
  contributes: Partial<Record<PluginContributionPoint, readonly unknown[]>>
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
  if (manifest.main !== undefined) {
    return 'trusted-worker'
  }
  let required: PluginExecutionProfile = manifest.capabilities.length > 0 ? 'instructional' : 'data'
  for (const point of PLUGIN_CONTRIBUTION_POINTS) {
    const profile = PLUGIN_CONTRIBUTION_POINT_POLICY[point].execution
    if ((manifest.contributes[point]?.length ?? 0) > 0 && rank(profile) > rank(required)) {
      required = profile
    }
  }
  return required
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
