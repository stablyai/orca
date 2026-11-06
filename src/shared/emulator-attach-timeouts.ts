export const ANDROID_AVD_BOOT_TIMEOUT_MS = 180_000

// Outlasts the host's boot wait so its own error, not a client timeout, reaches the CLI user.
export const EMULATOR_ATTACH_RPC_TIMEOUT_MS = ANDROID_AVD_BOOT_TIMEOUT_MS + 60_000
