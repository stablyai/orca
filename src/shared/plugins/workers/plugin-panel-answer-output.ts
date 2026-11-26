import { pluginError, type PluginError } from '../frames/plugin-protocol'
import {
  PLUGIN_PANEL_BYTES_RESULT_MAX_BYTES,
  pluginPanelBytesTooLarge
} from './plugin-panel-bridge-protocol'

/**
 * What a panel handler's answer leaves the worker as. A typed array goes as an ArrayBuffer of
 * exactly its own range (`plugin.requestBytes`), never the whole buffer behind it. Shared with
 * the `orca/testing` worker stand-in, so a test gets what Orca sends.
 */
export function pluginPanelAnswerOutput(
  name: string,
  output: unknown
): { output: unknown } | { error: PluginError } {
  const view = ArrayBuffer.isView(output) ? output : null
  const size = view?.byteLength ?? (output instanceof ArrayBuffer ? output.byteLength : 0)
  // Why here: binary data the host would refuse must not cross the process boundary.
  if (size > PLUGIN_PANEL_BYTES_RESULT_MAX_BYTES) {
    return { error: pluginError('too_large', pluginPanelBytesTooLarge(name)) }
  }
  return { output: view ? viewBytes(view) : output }
}

function viewBytes({ buffer, byteOffset, byteLength }: ArrayBufferView): ArrayBuffer {
  return buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength
    ? buffer
    : new Uint8Array(buffer, byteOffset, byteLength).slice().buffer
}
