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
  /** Not frozen yet: only development plugins may call it, and no minor, method list or typings
   *  count it. Promotion deletes the flag and sets `since`. */
  proposed?: true
  /** Machine-readable resource boundary enforced by the host binding. */
  scope: 'active-workspace' | 'any-workspace' | 'explicit-terminal' | 'plugin-private' | 'desktop'
  /** Null: no capability; consent and the surface still gate the call. */
  capability: PluginCapabilityKind | null
  /** A second capability a call needs when it passes the named param. */
  paramCapabilities?: Readonly<Record<string, PluginCapabilityKind>>
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

/** Whether a caller may use the method: proposed methods only from development plugins. */
export function pluginHostMethodOffered(
  entry: Pick<PluginHostMethodSpec, 'proposed'>,
  allowProposed: boolean
): boolean {
  return entry.proposed !== true || allowProposed
}

/** The minor a surface first got the method. */
export function pluginHostMethodSinceFor(
  entry: PluginHostMethodSpec,
  surface: PluginSurface
): number {
  return surface === 'worker' ? entry.since : Math.max(entry.since, entry.framesSince ?? 0)
}
