/** The mobile app's page <-> shell frame ceiling, in UTF-8 bytes. The installed app ends any stream
 *  whose event frame is larger, and released apps keep this value, so hosts size streamed frames to
 *  fit it rather than to the relay's larger cap. */
export const MOBILE_BRIDGE_MAX_FRAME_BYTES = 640 * 1024
