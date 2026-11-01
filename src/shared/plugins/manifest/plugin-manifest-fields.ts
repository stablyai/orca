import { z } from 'zod'
import {
  isSafePluginRelativePath,
  PLUGIN_RELATIVE_PATH_RE
} from '../installation/plugin-path-safety'
import {
  isReservedPluginName,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_RE
} from '../installation/plugin-id-format'

export {
  isPluginManifestId,
  isSafePluginId,
  PLUGIN_ID_MAX_LENGTH
} from '../installation/plugin-id-format'

const RELATIVE_PATH_MESSAGE = 'must be a portable relative path inside the plugin directory'

// Why regex then refine: the regex is the published `pattern`; the refine only adds the rule a
// pattern cannot express, so one bad value never reports twice.
export const pluginIdSchema = z
  .string()
  .max(PLUGIN_ID_MAX_LENGTH)
  .regex(PLUGIN_ID_RE, 'must be kebab-case (a-z, 0-9, dashes)')
  .refine((id) => !isReservedPluginName(id), 'must not be a reserved name')

// Keep artifacts under immutable roots; reading separately checks realpath containment against symlink escapes.
export const pluginRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(PLUGIN_RELATIVE_PATH_RE, RELATIVE_PATH_MESSAGE)
  .refine(
    (value) => !PLUGIN_RELATIVE_PATH_RE.test(value) || isSafePluginRelativePath(value),
    RELATIVE_PATH_MESSAGE
  )

// Canonicalize directory paths (allowing trailing slash) so hashing, materialization and cleanup share identity.
export const pluginRelativeDirectorySchema = z
  .string()
  .min(1)
  .max(1024)
  .transform((value) => value.replace(/[\\/]+$/, ''))
  .refine(isSafePluginRelativePath, RELATIVE_PATH_MESSAGE)

export const pluginCommandIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/, 'must be a portable command id')
