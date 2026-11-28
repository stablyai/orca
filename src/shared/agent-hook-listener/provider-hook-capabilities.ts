type ProviderHookCapabilities = {
  capturesProcessIdentity?: true
}

export const PROVIDER_HOOK_CAPABILITIES: Readonly<Record<string, ProviderHookCapabilities>> = {
  antigravity: { capturesProcessIdentity: true },
  claude: { capturesProcessIdentity: true },
  droid: { capturesProcessIdentity: true }
}
