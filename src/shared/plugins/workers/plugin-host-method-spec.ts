import type { z } from 'zod'
import type { PluginCapabilityKind } from '../capabilities/plugin-capabilities'
import type { PluginSurface } from '../frames/plugin-protocol'

export type PluginHostMethodSpec<
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType
> = {
  /** One line for the generated reference. */
  summary: string
  /** Host API minor the method appeared in (`0` for the first set); `api.minor` is the highest. */
  since: number
  /** Minor in which panels and editors gained a method workers had since `since`. */
  framesSince?: number
  /** Minor that deprecated it; it keeps working until the next major. */
  deprecatedSince?: number
  /** Machine-readable resource boundary enforced by the host binding. */
  scope: 'active-workspace' | 'explicit-terminal' | 'plugin-private' | 'desktop'
  /** Null: no capability; consent and the surface still gate the call. */
  capability: PluginCapabilityKind | null
  /** Runs only on transient user activation in the calling frame, checked by the frame host. */
  userActivation?: true
  /** Mutations are audit-logged with actor `plugin:<id>`. */
  mutation: boolean
  /** Where plugin code may call it; any other surface gets `not_permitted`. */
  surfaces: readonly PluginSurface[]
  params: P
  result: R
}

export const ALL_SURFACES = ['worker', 'panel', 'editor'] as const
export const WORKER_ONLY = ['worker'] as const
export const FRAMES_ONLY = ['panel', 'editor'] as const

export const spec = <P extends z.ZodType, R extends z.ZodType>(
  entry: PluginHostMethodSpec<P, R>
): PluginHostMethodSpec<P, R> => entry

/** The minor a surface first got the method. */
export function pluginHostMethodSinceFor(
  entry: PluginHostMethodSpec,
  surface: PluginSurface
): number {
  return surface === 'worker' ? entry.since : Math.max(entry.since, entry.framesSince ?? 0)
}
