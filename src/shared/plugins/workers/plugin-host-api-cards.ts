import { z } from 'zod'
import {
  PLUGIN_CARD_FIELDS_LIMITS,
  pluginCardFieldValueSchema
} from '../contributions/plugin-card-fields-state'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

const cardsSetFieldsParams = z.strictObject({
  workspaceId: z.string().min(1).max(4096),
  /** Replaces this workspace's fields; null clears them. */
  fields: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), pluginCardFieldValueSchema)
    .refine(
      (fields) => Object.keys(fields).length <= PLUGIN_CARD_FIELDS_LIMITS.maxKeys,
      `at most ${PLUGIN_CARD_FIELDS_LIMITS.maxKeys} fields`
    )
    .refine(
      (fields) => JSON.stringify(fields).length <= PLUGIN_CARD_FIELDS_LIMITS.maxBytes,
      `at most ${PLUGIN_CARD_FIELDS_LIMITS.maxBytes} bytes of fields per workspace`
    )
    .nullable()
})
const cardsSetFieldsResult = z.object({ ok: z.literal(true) })

/** The plugin's own workspace card data; spread into PLUGIN_HOST_API. */
export const PLUGIN_CARDS_API = {
  'cards.setFields': spec({
    summary:
      "Sets the values this plugin's `contributes.sidebarCards` read as `fields.<key>` for one workspace (the `workspaceId` that workspace events and `workspace.readContext` name). Replaces that workspace's fields; `null` clears them. Strings, finite numbers, booleans and null, at most 32 keys and 4 KiB per workspace. Windows redraw at most 4 times a second however often it is called. Desktop app only; lasts until Orca restarts or the plugin is disabled.",
    since: 4,
    scope: 'plugin-private',
    capability: null,
    // Why not audited: it only feeds the plugin's own cards, possibly many times a minute.
    mutation: false,
    surfaces: WORKER_ONLY,
    params: cardsSetFieldsParams,
    result: cardsSetFieldsResult
  })
}
