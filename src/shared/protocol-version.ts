// Why: declares the desktop's mobile-pairing protocol version so mobile
// builds can detect declared-incompatible combos and hard-block at pair
// time. Today's values are wide-open (mobile=any, desktop=any), so
// nothing actually blocks; the wire format is ready for the day we
// ship a genuinely-breaking change.
//
// Bump DESKTOP_PROTOCOL_VERSION when:
//   - You remove an RPC method or required parameter that mobile uses.
//   - You change the meaning (units, nullability) of an existing field
//     mobile reads.
//   - You change encryption, framing, or the auth handshake.
// Do NOT bump for:
//   - Adding new RPC methods.
//   - Adding new optional fields on existing methods.
//   - Adding new event types in `terminal.subscribe`.
//
// Bump MIN_COMPATIBLE_MOBILE_VERSION when desktop ships a change that
// requires a minimum mobile version to function safely. This is the
// "kill switch": desktop can refuse old mobile builds without needing
// a desktop release of mobile.

export const DESKTOP_PROTOCOL_VERSION = 1
export const MIN_COMPATIBLE_MOBILE_VERSION = 0
