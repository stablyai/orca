import { isQualifiedPluginKey } from './plugin-manifest'
import { isSafePluginId } from './plugin-id-format'

/** Identifies one task source of one plugin, e.g. for the Tasks page tab. */
export type PluginTaskSourceRef = {
  pluginKey: string
  sourceId: string
}

/** Settings encoding: `<publisher>.<id>/<sourceId>`; neither part may contain `/`. */
export function pluginTaskSourceKey(ref: PluginTaskSourceRef): string {
  return `${ref.pluginKey}/${ref.sourceId}`
}

export function parsePluginTaskSourceKey(value: unknown): PluginTaskSourceRef | null {
  if (typeof value !== 'string') {
    return null
  }
  const separator = value.indexOf('/')
  if (separator <= 0) {
    return null
  }
  const pluginKey = value.slice(0, separator)
  const sourceId = value.slice(separator + 1)
  return isQualifiedPluginKey(pluginKey) && isSafePluginId(sourceId)
    ? { pluginKey, sourceId }
    : null
}

export function isSamePluginTaskSource(
  a: PluginTaskSourceRef | null | undefined,
  b: PluginTaskSourceRef | null | undefined
): boolean {
  return Boolean(a && b && a.pluginKey === b.pluginKey && a.sourceId === b.sourceId)
}

export type ActivePluginTaskSourceResolution =
  | { kind: 'builtin' }
  /** A plugin source was asked for but the plugin list has not loaded yet. */
  | { kind: 'pending' }
  | { kind: 'plugin'; source: PluginTaskSourceRef }

/**
 * Decides whether the Tasks page shows a plugin source. An explicit request
 * wins; a bare open (no built-in source or item requested) falls back to the
 * last plugin source the user picked, if that plugin still offers it.
 */
export function resolveActivePluginTaskSource(args: {
  requested: PluginTaskSourceRef | undefined
  requestsBuiltin: boolean
  savedDefault: string | null | undefined
  available: readonly PluginTaskSourceRef[]
  availableReady: boolean
}): ActivePluginTaskSourceResolution {
  const candidate =
    args.requested ?? (args.requestsBuiltin ? null : parsePluginTaskSourceKey(args.savedDefault))
  if (!candidate) {
    return { kind: 'builtin' }
  }
  if (args.available.some((source) => isSamePluginTaskSource(source, candidate))) {
    return { kind: 'plugin', source: candidate }
  }
  return args.availableReady ? { kind: 'builtin' } : { kind: 'pending' }
}
