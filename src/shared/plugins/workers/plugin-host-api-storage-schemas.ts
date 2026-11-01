import { z } from 'zod'

/** Params and results of the plugin-private storage, secrets and settings host methods. */

const RESERVED_STORAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const storageKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((key) => !RESERVED_STORAGE_KEYS.has(key), 'reserved storage key')
const pluginJsonValueSchema = z.json()
export type PluginJsonValue = z.infer<typeof pluginJsonValueSchema>
/** Caps keep per-plugin storage an honest key-value store, not a database. */
export const PLUGIN_STORAGE_VALUE_MAX_BYTES = 256 * 1024
export const PLUGIN_STORAGE_TOTAL_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_STORAGE_KEY_LIMIT = 1024

export const storageGetParams = z.strictObject({ key: storageKeySchema })
export const storageGetResult = z.object({ value: pluginJsonValueSchema })
export const storageSetParams = z.strictObject({
  key: storageKeySchema,
  value: pluginJsonValueSchema
})
export const storageSetResult = z.object({ ok: z.literal(true) })
export const storageDeleteParams = z.strictObject({ key: storageKeySchema })
export const storageDeleteResult = z.object({ ok: z.literal(true) })
export const storageKeysParams = z.strictObject({}).optional()
export const storageKeysResult = z.object({
  keys: z.array(z.string()).max(PLUGIN_STORAGE_KEY_LIMIT)
})

export const secretsGetParams = z.strictObject({ key: storageKeySchema })
export const secretsGetResult = z.object({ value: z.string().nullable() })
export const secretsSetParams = z.strictObject({
  key: storageKeySchema,
  value: z.string().max(64 * 1024)
})
export const secretsSetResult = z.object({ ok: z.literal(true) })
export const secretsDeleteParams = z.strictObject({ key: storageKeySchema })
export const secretsDeleteResult = z.object({ ok: z.literal(true) })
export const secretsProtectionParams = z.strictObject({}).optional()
/** `os-keyring`: encrypted with an OS key store; `unavailable`: writes are refused. */
export const secretsProtectionResult = z.object({ status: z.enum(['os-keyring', 'unavailable']) })

export const settingsGetParams = z.strictObject({}).optional()
export const settingsGetResult = z.object({ settings: z.record(z.string(), pluginJsonValueSchema) })
export const settingsSetParams = z.strictObject({
  key: storageKeySchema,
  value: pluginJsonValueSchema
})
export const settingsSetResult = z.object({ ok: z.literal(true) })
