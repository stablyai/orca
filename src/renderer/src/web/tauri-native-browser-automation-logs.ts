import type {
  BrowserConsoleResult,
  BrowserNetworkLogResult
} from '../../../shared/browser/runtime/runtime-browser-contracts'
import type { AutomationCommandContext, TauriCdpSender } from './tauri-native-browser-automation'
import {
  readTauriBrowserConsole,
  readTauriBrowserNetworkLog,
  subscribeTauriBrowserCdpEvents,
  TAURI_BROWSER_CONSOLE_EVENTS,
  TAURI_BROWSER_NETWORK_EVENTS
} from './tauri-native-browser-cdp-events'

// Log readers for the Tauri client host: the Rust bridge taps DevTools
// events into per-page buffers, so console/network reads are local and never
// block on the page. Reads slice the last `limit` entries like the CDP
// bridge, so agents page through history instead of one capped dump.

async function ensureLogEvents(
  send: TauriCdpSender,
  browserPageId: string,
  events: readonly string[],
  domainEnable: string
): Promise<void> {
  await subscribeTauriBrowserCdpEvents(browserPageId, events)
  await send(domainEnable, {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
}

export async function consoleAutomationLog(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<BrowserConsoleResult> {
  await ensureLogEvents(
    context.send,
    context.browserPageId,
    TAURI_BROWSER_CONSOLE_EVENTS,
    'Runtime.enable'
  )
  return readTauriBrowserConsole(context.browserPageId, params.limit)
}

export async function networkAutomationLog(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<BrowserNetworkLogResult> {
  await ensureLogEvents(
    context.send,
    context.browserPageId,
    TAURI_BROWSER_NETWORK_EVENTS,
    'Network.enable'
  )
  return readTauriBrowserNetworkLog(context.browserPageId, params.limit)
}
