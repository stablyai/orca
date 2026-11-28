// Local webhooks: this host takes webhook calls on its own port instead of through Orca Cloud.
import { resolveHostOwnedSetting } from '../settings/host-owned-settings'

export { isLocalWebhookBindAddress } from './local-webhook-bind-address'

/** The host's local webhook settings; each is host-owned (host-owned-settings.ts). */
export type LocalWebhookSettings = {
  /** Calls on this host's own port, not through Orca Cloud. Off by default. */
  localWebhooksEnabled?: boolean
  /** The address the listener binds; missing = 127.0.0.1. */
  localWebhooksBindAddress?: string
  localWebhooksPort?: number
  /** What senders reach the listener at (for example a reverse proxy or a VPN); empty = its own http:// address. */
  localWebhooksPublicUrl?: string
}

export type LocalWebhookConfig = {
  bindAddress: string
  port: number
  /** What senders POST to, without /hooks/...: the Public URL, or the listener's own http:// address. */
  baseUrl: string
}

/** Why a Public URL can't be used, or null for an empty or valid one. */
export function localWebhookPublicUrlProblem(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') {
    return null
  }
  try {
    const url = new URL(trimmed)
    // A literal ? or #, even empty, would put /hooks/... in the query or the fragment.
    return (url.protocol === 'http:' || url.protocol === 'https:') && !/[?#]/.test(trimmed)
      ? null
      : 'Use an http:// or https:// URL without ? or #.'
  } catch {
    return 'Use an http:// or https:// URL without ? or #.'
  }
}

/** The URL a hook's path goes after. */
export function localWebhookBaseUrl(bindAddress: string, port: number, publicUrl: string): string {
  const trimmed = publicUrl.trim()
  if (trimmed !== '' && localWebhookPublicUrlProblem(trimmed) === null) {
    // As a sender parses it: a trailing backslash, for one, is a slash.
    return new URL(trimmed).href.replace(/\/+$/, '')
  }
  const host = bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress
  return `http://${host}:${port}`
}

/** The host's local webhook listener, or null while local webhooks are off. */
export function localWebhookConfig(
  settings: Readonly<Record<string, unknown>>
): LocalWebhookConfig | null {
  if (!resolveHostOwnedSetting(settings, 'localWebhooksEnabled')) {
    return null
  }
  const bindAddress =
    resolveHostOwnedSetting(settings, 'localWebhooksBindAddress').trim() ||
    resolveHostOwnedSetting({}, 'localWebhooksBindAddress')
  const port = resolveHostOwnedSetting(settings, 'localWebhooksPort')
  const publicUrl = resolveHostOwnedSetting(settings, 'localWebhooksPublicUrl')
  return { bindAddress, port, baseUrl: localWebhookBaseUrl(bindAddress, port, publicUrl) }
}
