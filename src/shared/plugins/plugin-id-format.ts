// Why separate from plugin-manifest-fields: these are the pure id rules the
// zod schemas refine, and boot-path callers (sidebar routing) need them without
// pulling zod in.
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DANGEROUS_PLUGIN_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

export const PLUGIN_ID_MAX_LENGTH = 64

export function isSafePluginId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length <= PLUGIN_ID_MAX_LENGTH &&
    PLUGIN_ID_RE.test(id) &&
    !DANGEROUS_PLUGIN_NAMES.has(id)
  )
}

export function isPluginManifestId(value: string): boolean {
  return PLUGIN_ID_RE.test(value)
}
