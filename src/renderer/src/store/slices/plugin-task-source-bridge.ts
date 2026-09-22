import type { z } from 'zod'
import type {
  PluginTaskSourceMethod,
  PluginTaskSourceResult
} from '../../../../shared/plugins/plugin-task-source-contract'
import type { SelectedPluginTaskSource } from './plugin-task-sources-slice-contract'

/** Routes through the sanctioned `plugins:invokeTaskSource` bridge only —
 *  never `PluginService.invokeTaskSource` directly (see plugin-task-source-invoker.ts).
 *  A missing bridge, a thrown call and a payload that fails the contract all
 *  reach the caller as the same envelope, so no failure can be read as data. */
export async function invokePluginTaskSource<Schema extends z.ZodTypeAny>(
  selection: SelectedPluginTaskSource,
  method: PluginTaskSourceMethod,
  schema: Schema,
  params?: unknown
): Promise<PluginTaskSourceResult<z.infer<Schema>>> {
  const invoke = window.api?.plugins?.invokeTaskSource
  if (!invoke) {
    return { ok: false, code: 'unavailable', message: 'Plugin bridge is unavailable.' }
  }
  try {
    const result = await invoke({
      pluginKey: selection.pluginKey,
      sourceId: selection.sourceId,
      method,
      // Omitted rather than sent as undefined: a source that never took params
      // must see the request it saw before any of them existed.
      ...(params === undefined ? {} : { params })
    })
    if (!result.ok) {
      return result
    }
    return { ok: true, data: schema.parse(result.data) }
  } catch (error) {
    return {
      ok: false,
      code: 'unavailable',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function isSamePluginTaskSourceSelection(
  a: SelectedPluginTaskSource | null,
  b: SelectedPluginTaskSource
): boolean {
  return a !== null && a.pluginKey === b.pluginKey && a.sourceId === b.sourceId
}
