import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** Params and results of the plugin-private storage, secrets and settings host methods. */

const RESERVED_STORAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const storageKeySchema = lazyZodSchema(() =>
  z
    .string()
    .min(1)
    .max(256)
    .refine((key) => !RESERVED_STORAGE_KEYS.has(key), 'reserved storage key')
)
const pluginJsonValueSchema = lazyZodSchema(() => z.json())
export type PluginJsonValue = z.infer<typeof pluginJsonValueSchema>
/** Caps keep per-plugin storage an honest key-value store, not a database. */
export const PLUGIN_STORAGE_VALUE_MAX_BYTES = 256 * 1024
export const PLUGIN_STORAGE_TOTAL_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_STORAGE_KEY_LIMIT = 1024

export const storageGetParams = lazyZodSchema(() => z.strictObject({ key: storageKeySchema }))
export const storageGetResult = lazyZodSchema(() => z.object({ value: pluginJsonValueSchema }))
export const storageSetParams = lazyZodSchema(() =>
  z.strictObject({
    key: storageKeySchema,
    value: pluginJsonValueSchema
  })
)
export const storageSetResult = lazyZodSchema(() => z.object({ ok: z.literal(true) }))
export const storageDeleteParams = lazyZodSchema(() => z.strictObject({ key: storageKeySchema }))
export const storageDeleteResult = lazyZodSchema(() => z.object({ ok: z.literal(true) }))
export const storageKeysParams = lazyZodSchema(() => z.strictObject({}).optional())
export const storageKeysResult = lazyZodSchema(() =>
  z.object({
    keys: z.array(z.string()).max(PLUGIN_STORAGE_KEY_LIMIT)
  })
)

export const secretsGetParams = lazyZodSchema(() => z.strictObject({ key: storageKeySchema }))
export const secretsGetResult = lazyZodSchema(() => z.object({ value: z.string().nullable() }))
export const secretsSetParams = lazyZodSchema(() =>
  z.strictObject({
    key: storageKeySchema,
    value: z.string().max(64 * 1024)
  })
)
export const secretsSetResult = lazyZodSchema(() => z.object({ ok: z.literal(true) }))
export const secretsDeleteParams = lazyZodSchema(() => z.strictObject({ key: storageKeySchema }))
export const secretsDeleteResult = lazyZodSchema(() => z.object({ ok: z.literal(true) }))
export const secretsProtectionParams = lazyZodSchema(() => z.strictObject({}).optional())
/** `os-keyring`: encrypted with an OS key store; `unavailable`: writes are refused. */
export const secretsProtectionResult = lazyZodSchema(() =>
  z.object({ status: z.enum(['os-keyring', 'unavailable']) })
)

export const settingsGetParams = lazyZodSchema(() => z.strictObject({}).optional())
export const settingsGetResult = lazyZodSchema(() =>
  z.object({ settings: z.record(z.string(), pluginJsonValueSchema) })
)
export const settingsSetParams = lazyZodSchema(() =>
  z.strictObject({
    key: storageKeySchema,
    value: pluginJsonValueSchema
  })
)
export const settingsSetResult = lazyZodSchema(() => z.object({ ok: z.literal(true) }))
