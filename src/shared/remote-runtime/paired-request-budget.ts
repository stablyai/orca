// What one CLI call may send a host: a paired server refuses a larger request by closing the
// connection, which fails every call on it. Files ride inside as base64, a third larger.
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from './remote-runtime-memory-limits'

// Request id, device token, method name and JSON framing around the params.
const REQUEST_ENVELOPE_RESERVE_BYTES = 4 * 1024

/** The most JSON one call's params may take. */
export const PAIRED_REQUEST_PARAMS_MAX_BYTES =
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES - REQUEST_ENVELOPE_RESERVE_BYTES

/** Raw file bytes whose base64 fits the params, with `reserveBytes` left for the other fields. */
export function pairedRequestFileBudget(reserveBytes: number): number {
  return Math.floor((PAIRED_REQUEST_PARAMS_MAX_BYTES - reserveBytes) / 4) * 3
}
