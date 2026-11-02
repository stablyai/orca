import { z } from 'zod'
import { PLUGIN_STORAGE_VALUE_MAX_BYTES } from '../workers/plugin-host-api-storage-schemas'
import { PLUGIN_DECLARATIVE_CALLBACK_ID } from './plugin-declarative-catalog'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import {
  parsePluginDeclarativeTree,
  type PluginDeclarativeTreeResult
} from './plugin-declarative-tree'

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** The guest document a message belongs to; renders, events and acks never cross a reload. */
const documentSchema = z.string().min(1).max(64)

const eventScalarSchema = z.union([
  z.string().max(LIMITS.maxTextLength),
  z.number().refine(Number.isFinite),
  z.boolean(),
  z.null()
])
const eventListSchema = z.array(eventScalarSchema).max(LIMITS.maxEventArgItems)
/** A scalar, a list of scalars (a Slider value, selected keys), or one flat object of either
 *  (`{ keys }`, `{ column, direction }`): plain JSON a handler can read without checks. */
export const pluginDeclarativeEventArgSchema = z.union([
  eventScalarSchema,
  eventListSchema,
  z
    .record(z.string().max(64), z.union([eventScalarSchema, eventListSchema]))
    .refine((value) => Object.keys(value).length <= 16, 'too many fields')
])
export type PluginDeclarativeEventArg = z.infer<typeof pluginDeclarativeEventArgSchema>

export const pluginDeclarativeEventPayloadSchema = z
  .object({
    document: documentSchema,
    revision: revisionSchema,
    callback: z
      .string()
      .min(1)
      .max(LIMITS.maxCallbackIdLength)
      .regex(PLUGIN_DECLARATIVE_CALLBACK_ID),
    args: z.array(pluginDeclarativeEventArgSchema).max(LIMITS.maxEventArgs),
    /** Value controls: this edit's id, so the next render can say it has seen it. */
    edit: revisionSchema.optional()
  })
  .strict()
export type PluginDeclarativeEventPayload = z.infer<typeof pluginDeclarativeEventPayloadSchema>

/** The `ui.render` envelope; the tree has its own iterative, capped validator. */
export const pluginDeclarativeRenderPayloadSchema = z
  .object({ document: documentSchema, revision: revisionSchema, tree: z.unknown() })
  .strict()
export type PluginDeclarativeRenderPayload = z.infer<typeof pluginDeclarativeRenderPayloadSchema>

export const pluginDeclarativeErrorPayloadSchema = z
  .object({
    document: documentSchema.optional(),
    revision: revisionSchema,
    message: z.string().max(LIMITS.maxLabelLength * 4),
    /** Where it threw, for `orca plugin check` and tests; the host shows only `message`. */
    stack: z.string().max(8192).optional()
  })
  .strict()
export type PluginDeclarativeErrorPayload = z.infer<typeof pluginDeclarativeErrorPayloadSchema>

export type PluginDeclarativeRenderResult =
  | (Extract<PluginDeclarativeTreeResult, { ok: true }> & { document: string; revision: number })
  | { ok: false; document: string | null; revision: number | null; error: string }

/** Parses a `ui.render` payload, keeping the document and revision even when the tree is refused. */
export function parsePluginDeclarativeRender(payload: unknown): PluginDeclarativeRenderResult {
  const envelope = pluginDeclarativeRenderPayloadSchema.safeParse(payload)
  if (!envelope.success) {
    return { ok: false, document: null, revision: null, error: 'malformed render' }
  }
  const { document, revision } = envelope.data
  const tree = parsePluginDeclarativeTree(envelope.data.tree)
  return tree.ok
    ? { ...tree, document, revision }
    : { ok: false, document, revision, error: tree.error }
}

/** Document and revision of a `ui.render` refused before parsing (e.g. rate-limited). */
export function pluginDeclarativeRenderIdentity(
  payload: unknown
): { document: string; revision: number } | null {
  const parsed = z.object({ document: documentSchema, revision: revisionSchema }).safeParse(payload)
  return parsed.success ? parsed.data : null
}

export const pluginDeclarativeAckPayloadSchema = z
  .object({
    document: documentSchema,
    revision: revisionSchema,
    accepted: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().max(60_000).optional()
  })
  .strict()
export type PluginDeclarativeAckPayload = z.infer<typeof pluginDeclarativeAckPayloadSchema>

export const pluginDeclarativeReadyPayloadSchema = z.object({ document: documentSchema }).strict()

export const PLUGIN_DECLARATIVE_STATE_KEY = /^[A-Za-z0-9_.:-]{1,128}$/
export const PLUGIN_DECLARATIVE_PERSIST_SCOPES = ['plugin', 'workspace'] as const
export type PluginDeclarativePersistScope = (typeof PLUGIN_DECLARATIVE_PERSIST_SCOPES)[number]
const storedVersionSchema = z.number().int().min(0).max(1_000_000)

/** One persisted atom value, as the guest writes it and the host stores it. */
export const pluginDeclarativeStoredValueSchema = z
  .object({ version: storedVersionSchema, value: z.json() })
  .strict()
  .refine(
    (entry) => JSON.stringify(entry.value).length <= PLUGIN_STORAGE_VALUE_MAX_BYTES,
    'persisted value is too large'
  )
export type PluginDeclarativeStoredValue = z.infer<typeof pluginDeclarativeStoredValueSchema>

export const pluginDeclarativePersistPayloadSchema = z
  .object({
    document: documentSchema,
    entries: z
      .array(
        z
          .object({
            scope: z.enum(PLUGIN_DECLARATIVE_PERSIST_SCOPES),
            key: z.string().regex(PLUGIN_DECLARATIVE_STATE_KEY),
            version: storedVersionSchema,
            value: z.json()
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict()
export type PluginDeclarativePersistPayload = z.infer<typeof pluginDeclarativePersistPayloadSchema>

/**
 * guest → host `ui.retain` (dev hot reload only): keyed memory atoms that changed. An entry without
 * `value` held something that is not plain JSON, so the next guest starts that atom over.
 */
export const pluginDeclarativeRetainPayloadSchema = z
  .object({
    document: documentSchema,
    entries: z
      .array(
        z
          .object({
            key: z.string().regex(PLUGIN_DECLARATIVE_STATE_KEY),
            version: storedVersionSchema,
            value: z.json().optional()
          })
          .strict()
          .refine(
            (entry) => JSON.stringify(entry.value ?? null).length <= PLUGIN_STORAGE_VALUE_MAX_BYTES,
            'retained value is too large'
          )
      )
      .min(1)
      .max(64)
  })
  .strict()
export type PluginDeclarativeRetainPayload = z.infer<typeof pluginDeclarativeRetainPayloadSchema>

/** host → guest `ui.hydrate`; scopes are absent when the host has nothing new for them. */
export type PluginDeclarativeHydratePayload = {
  panel?: { id: string }
  visible?: boolean
  plugin?: Record<string, PluginDeclarativeStoredValue>
  workspace?: Record<string, PluginDeclarativeStoredValue>
  /** Keyed memory atoms of the guest a dev hot reload replaced. */
  memory?: Record<string, PluginDeclarativeStoredValue>
  /** Dev folders only: post `ui.retain` so the next hot reload can hand memory atoms over. */
  retain?: true
}
