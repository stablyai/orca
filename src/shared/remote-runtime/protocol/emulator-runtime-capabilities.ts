export const EMULATOR_OPENING_PREFERENCES_CAPABILITY = 'emulator.opening-preferences.v1' as const
/** emulator.shutdown honours activeDevice; older servers ignore it and stop whatever session is active. */
export const EMULATOR_SHUTDOWN_ACTIVE_DEVICE_CAPABILITY =
  'emulator.shutdown-active-device.v1' as const
export const EMULATOR_RUNTIME_CAPABILITIES = [
  EMULATOR_OPENING_PREFERENCES_CAPABILITY,
  EMULATOR_SHUTDOWN_ACTIVE_DEVICE_CAPABILITY
] as const
