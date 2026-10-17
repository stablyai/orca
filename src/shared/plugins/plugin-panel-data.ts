import { PANEL_MESSAGE_MAX_BYTES } from './plugin-panel-message-limits'
import { structuredCloneMessageBytes } from './plugin-panel-message-budget'

export type PluginPanelJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginPanelJsonValue[]
  | { [key: string]: PluginPanelJsonValue }

/** Bound traversal before JSON parsing, including cycles and deep inputs. */
export function isPluginPanelData(data: unknown): data is PluginPanelJsonValue {
  try {
    if (structuredCloneMessageBytes(data) > PANEL_MESSAGE_MAX_BYTES) {
      return false
    }
    const ancestors = new WeakSet<object>()
    let nodes = 0
    const visit = (value: unknown, depth: number): boolean => {
      if (++nodes > PANEL_MESSAGE_MAX_BYTES || depth > 128) {
        return false
      }
      if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true
      }
      if (typeof value === 'number') {
        return Number.isFinite(value)
      }
      if (typeof value !== 'object' || ancestors.has(value)) {
        return false
      }
      if (
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) {
        return false
      }
      ancestors.add(value)
      const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(
        (child) => visit(child, depth + 1)
      )
      ancestors.delete(value)
      return valid
    }
    if (!visit(data, 0)) {
      return false
    }
    return new TextEncoder().encode(JSON.stringify(data)).byteLength <= PANEL_MESSAGE_MAX_BYTES
  } catch {
    return false
  }
}
