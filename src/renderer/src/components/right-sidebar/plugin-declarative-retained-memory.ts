import {
  pluginDeclarativeRetainPayloadSchema,
  type PluginDeclarativeStoredValue
} from '../../../../shared/plugins/declarative/plugin-declarative-messages'

// Why a cap: retained values live in the renderer for as long as the panel stays open.
const MAX_RETAINED_KEYS = 512

/**
 * A dev components panel's keyed memory atoms, as its guests report them (`ui.retain`), so the
 * guest of the next dev save starts from them. Memory only: closing the panel drops them.
 */
export function createPluginDeclarativeRetainedMemory() {
  const values = new Map<string, PluginDeclarativeStoredValue>()
  return {
    /** Applies a `ui.retain` payload; false when it is malformed. */
    accept(payload: unknown): boolean {
      const parsed = pluginDeclarativeRetainPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        return false
      }
      for (const { key, version, value } of parsed.data.entries) {
        values.delete(key)
        // No value: not plain JSON, so the next guest starts that atom over.
        if (value !== undefined && values.size < MAX_RETAINED_KEYS) {
          values.set(key, { version, value })
        }
      }
      return true
    },
    snapshot(): Record<string, PluginDeclarativeStoredValue> | null {
      return values.size > 0 ? Object.fromEntries(values) : null
    }
  }
}
