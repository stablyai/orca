// A coordinated bump strands installed shells and cached pages, so this is the one compat gate.
export const MOBILE_WEB_BRIDGE_PROTOCOL_VERSION = 2
export const MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES = 640 * 1024
export const MOBILE_WEB_BRIDGE_ENVELOPE_RESERVE_BYTES = 40 * 1024
export const MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES =
  MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES - MOBILE_WEB_BRIDGE_ENVELOPE_RESERVE_BYTES
export const MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS = 64
export const MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS = 32
export const MOBILE_WEB_BRIDGE_MAX_GRANTS = 256

/** The range a Desktop-built page package declares in its manifest, which the shell checks before
 * opening it. Only one bridge version exists, so both ends are that version. */
export const MOBILE_WEB_PACKAGE_BRIDGE_RANGE = {
  minimum: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  testedThrough: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
} as const
