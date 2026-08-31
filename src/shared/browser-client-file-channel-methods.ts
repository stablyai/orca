import type { BrowserClientAutomationMethod } from './browser-client-automation-protocol'

// Why: these methods name a filesystem path; on a client-placed page the path means the REMOTE
// workspace, so they may only run once both peers negotiated the staging file channel.
const FILE_CHANNEL_AUTOMATION_METHODS = new Set<string>(['browser.upload', 'browser.download'])

export const BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR =
  'browser_client_file_channel_unsupported' as const

export function requiresBrowserClientFileChannel(method: BrowserClientAutomationMethod): boolean {
  return FILE_CHANNEL_AUTOMATION_METHODS.has(method)
}
