import { z } from 'zod'

/** A field value a card template reads as `fields.<key>`. */
export const pluginCardFieldValueSchema = z.union([
  z.string().max(1024),
  z.number().finite(),
  z.boolean(),
  z.null()
])

export const PLUGIN_CARD_FIELDS_LIMITS = {
  /** JSON size of one workspace's fields. */
  maxBytes: 4 * 1024,
  maxKeys: 32,
  /** Changes reach the windows at most this often, however often a worker writes. */
  pushIntervalMs: 250
} as const

export type PluginCardFields = Readonly<Record<string, z.infer<typeof pluginCardFieldValueSchema>>>

/** What workers set for their cards, by plugin key then workspace id; main pushes it to windows. */
export type PluginCardFieldsSnapshot = Readonly<
  Record<string, Readonly<Record<string, PluginCardFields>>>
>

/** main → renderer: a new PluginCardFieldsSnapshot. */
export const PLUGIN_CARD_FIELDS_CHANGED_CHANNEL = 'plugins:cardFieldsChanged'
