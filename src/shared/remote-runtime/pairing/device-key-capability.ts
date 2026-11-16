// Keep crypto out: protocol-version reaches the relocated Windows daemon bundle, which cannot resolve crypto packages. Proofs live in device-key-proof.ts.

// Older hosts reject key-auth as bad_auth and lack registerDeviceKey; migrate/present keys only after capability negotiation.
export const DEVICE_KEY_RUNTIME_CAPABILITY = 'pairing.device-key.v1' as const

// Why: registerDeviceKey's params are strict on older hosts, so `ephemeral` is sent only when advertised.
export const DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY = 'pairing.device-key-ephemeral.v1' as const

export const DEVICE_KEY_RUNTIME_CAPABILITIES = [
  DEVICE_KEY_RUNTIME_CAPABILITY,
  DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY
] as const

// Hosts that take clientCapabilities on direct v2 token auth; older v2 hosts answer that auth with bad_auth.
export const E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY =
  'pairing.e2ee-v2-token-capabilities.v1' as const

export const REGISTER_DEVICE_KEY_METHOD = 'pairing.registerDeviceKey' as const
