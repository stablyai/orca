import type {
  BrowserCaptureStartResult,
  BrowserCaptureStopResult
} from '../../../shared/browser/runtime/runtime-browser-contracts'
import type { AutomationCommandContext } from './tauri-native-browser-automation'
import {
  clearTauriBrowserNetworkPending,
  clearTauriBrowserPageLogs,
  setTauriBrowserPageCapturing,
  subscribeTauriBrowserCdpEvents,
  TAURI_BROWSER_CONSOLE_EVENTS,
  TAURI_BROWSER_NETWORK_EVENTS
} from './tauri-native-browser-cdp-events'

// Capture lifecycle for the Tauri client host, mirroring the CDP bridge:
// start enables the domains, drops stale history and opens the buffer
// window, stop closes the window but keeps what was recorded. Reads outside
// a capture see nothing, matching the bridge instead of leaking old logs.

export async function captureAutomationStart(
  context: AutomationCommandContext
): Promise<BrowserCaptureStartResult> {
  await subscribeTauriBrowserCdpEvents(context.browserPageId, TAURI_BROWSER_CONSOLE_EVENTS)
  await subscribeTauriBrowserCdpEvents(context.browserPageId, TAURI_BROWSER_NETWORK_EVENTS)
  await context.send('Runtime.enable', {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
  await context.send('Network.enable', {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
  clearTauriBrowserPageLogs(context.browserPageId)
  setTauriBrowserPageCapturing(context.browserPageId, true)
  return { capturing: true }
}

export function captureAutomationStop(context: AutomationCommandContext): BrowserCaptureStopResult {
  setTauriBrowserPageCapturing(context.browserPageId, false)
  clearTauriBrowserNetworkPending(context.browserPageId)
  return { stopped: true }
}
