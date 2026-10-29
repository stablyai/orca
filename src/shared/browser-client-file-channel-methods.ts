import type { BrowserClientAutomationMethod } from './browser-client-automation-protocol'

// Client-placed page paths name the remote workspace; require both peers to negotiate file staging before these methods run.
const FILE_CHANNEL_AUTOMATION_METHODS = new Set<string>(['browser.upload', 'browser.download'])

export const BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR =
  'browser_client_file_channel_unsupported' as const

export function requiresBrowserClientFileChannel(method: BrowserClientAutomationMethod): boolean {
  return FILE_CHANNEL_AUTOMATION_METHODS.has(method)
}
