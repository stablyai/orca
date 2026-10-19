// Why dependency-free: protocol-version.ts reaches the terminal daemon's bundle, and the relocated
// Windows daemon-host cannot resolve crypto packages; the proof code lives in device-key-proof.ts.

// Why: an older host refuses the key-auth shape with bad_auth and has no
// pairing.registerDeviceKey; clients migrate or present a key only when this is advertised.
export const DEVICE_KEY_RUNTIME_CAPABILITY = 'pairing.device-key.v1' as const

// Why: registerDeviceKey's params are strict on older hosts, so `ephemeral` is sent only when advertised.
export const DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY = 'pairing.device-key-ephemeral.v1' as const

export const DEVICE_KEY_RUNTIME_CAPABILITIES = [
  DEVICE_KEY_RUNTIME_CAPABILITY,
  DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY
] as const

export const REGISTER_DEVICE_KEY_METHOD = 'pairing.registerDeviceKey' as const
