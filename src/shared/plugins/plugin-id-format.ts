// Boot-path identity checks stay separate from manifest schemas to avoid importing Zod.
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
