import { z } from 'zod'

export const MOBILE_WEB_PAGE_PREFERENCE_MAX_VALUE_BYTES = 64 * 1024
export const MOBILE_WEB_PAGE_PREFERENCES_MAX_BYTES = 2 * 1024 * 1024
const Namespace = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/)
const Key = z.string().min(1).max(512)
const Value = z.string().max(MOBILE_WEB_PAGE_PREFERENCE_MAX_VALUE_BYTES)
const Scope = { namespace: Namespace }
export const MobileWebPagePreferencesPayloadSchema = z.discriminatedUnion('action', [
  z.object({ ...Scope, action: z.literal('read'), keys: z.array(Key).max(64) }).strict(),
  z
    .object({
      ...Scope,
      action: z.literal('write'),
      entries: z.array(z.tuple([Key, Value])).max(64)
    })
    .strict(),
  z.object({ ...Scope, action: z.literal('remove'), keys: z.array(Key).max(64) }).strict(),
  z.object({ ...Scope, action: z.literal('keys') }).strict(),
  z.object({ ...Scope, action: z.literal('clear') }).strict()
])
export const MobileWebPagePreferencesResultSchema = z.union([
  z.object({ entries: z.array(z.tuple([Key, Value.nullable()])).max(64) }).strict(),
  z.object({ keys: z.array(Key).max(256) }).strict(),
  z.object({ updated: z.literal(true) }).strict()
])
export const MobileWebPagePreferencesStoredSchema = z
  .array(z.tuple([Namespace, z.array(z.tuple([Key, Value])).max(256)]))
  .max(16)
export type MobileWebPagePreferencesPayload = z.infer<typeof MobileWebPagePreferencesPayloadSchema>
export type MobileWebPagePreferencesResult = z.infer<typeof MobileWebPagePreferencesResultSchema>
