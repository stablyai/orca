export const EMULATOR_OPENING_PREFERENCES_CAPABILITY = 'emulator.opening-preferences.v1' as const
/** The runtime serves `emulator.tunnel`, so paired desktops can reach its simulator streams. */
export const EMULATOR_TUNNEL_CAPABILITY = 'emulator.tunnel.v1' as const
export const EMULATOR_RUNTIME_CAPABILITIES = [
  EMULATOR_OPENING_PREFERENCES_CAPABILITY,
  EMULATOR_TUNNEL_CAPABILITY
] as const
