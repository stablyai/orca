export type WebhookGlobalSettings = {
  webhookServer?: WebhookServerSettings
}

export type WebhookServerSettings = {
  enabled: boolean
  bindAddress: string
  port: number
}

export const DEFAULT_WEBHOOK_SERVER_PORT = 8473
export const MIN_WEBHOOK_SERVER_PORT = 1
export const MAX_WEBHOOK_SERVER_PORT = 65535

export function getDefaultWebhookServerSettings(): WebhookServerSettings {
  return {
    enabled: false,
    // Why: loopback-only by default so enabling automations never silently
    // opens a LAN-reachable port. Users opt into a wider bind interface.
    bindAddress: '127.0.0.1',
    port: DEFAULT_WEBHOOK_SERVER_PORT
  }
}

/** Normalize untrusted webhook-server settings: clamp the port into range and
 *  fall back to the loopback default for a blank bind address. Missing fields
 *  inherit from `current` (or the defaults) so a partial update never drops
 *  the others. */
export function normalizeWebhookServerSettings(
  input: Partial<WebhookServerSettings> | null | undefined,
  current?: WebhookServerSettings | null
): WebhookServerSettings {
  const base = current ?? getDefaultWebhookServerSettings()
  const enabled = typeof input?.enabled === 'boolean' ? input.enabled : base.enabled
  const bindAddressRaw =
    typeof input?.bindAddress === 'string' ? input.bindAddress.trim() : base.bindAddress
  const bindAddress = bindAddressRaw.length > 0 ? bindAddressRaw : '127.0.0.1'
  const portRaw =
    typeof input?.port === 'number' && Number.isFinite(input.port) ? input.port : base.port
  const port = Math.min(
    MAX_WEBHOOK_SERVER_PORT,
    Math.max(MIN_WEBHOOK_SERVER_PORT, Math.trunc(portRaw))
  )
  return { enabled, bindAddress, port }
}
