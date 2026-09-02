import { z } from 'zod'
import { isSafePluginRelativePath } from './plugin-path-safety'

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

export const pluginIdSchema = z
  .string()
  .refine(isSafePluginId, 'must be kebab-case (a-z, 0-9, dashes) and not a reserved name')

// Why: every declared artifact stays inside the immutable plugin root; realpath
// containment separately rejects symlink escapes when the artifact is read.
export const pluginRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafePluginRelativePath, 'must be a portable relative path inside the plugin directory')

// Directory contributions accept the conventional trailing slash but store a
// canonical path so hashing, materialization, and cleanup use one identity.
export const pluginRelativeDirectorySchema = z
  .string()
  .min(1)
  .max(1024)
  .transform((value) => value.replace(/[\\/]+$/, ''))
  .refine(isSafePluginRelativePath, 'must be a portable relative path inside the plugin directory')

export const pluginCommandIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/, 'must be a portable command id')

export function isPluginManifestId(value: string): boolean {
  return PLUGIN_ID_RE.test(value)
}
