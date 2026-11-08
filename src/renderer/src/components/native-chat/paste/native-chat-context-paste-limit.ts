/** Bound clipboard text so a pathological payload cannot stall IPC. */
export const NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES = 16 * 1024 * 1024
