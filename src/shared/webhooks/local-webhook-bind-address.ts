// Its own file so host-owned-settings.ts can check the setting without importing local-webhook-settings.ts back.

/** Whether the address is an IPv4 or IPv6 literal, as the listener binds. */
export function isLocalWebhookBindAddress(address: string): boolean {
  const trimmed = address.trim()
  // The URL parser drops tabs and newlines inside, which the listener's own check would not.
  if (/\s/.test(trimmed)) {
    return false
  }
  try {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
      return new URL(`http://${trimmed}`).hostname === trimmed
    }
    return trimmed.includes(':') && new URL(`http://[${trimmed}]`).hostname.length > 2
  } catch {
    return false
  }
}
