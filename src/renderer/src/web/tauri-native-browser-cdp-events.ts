import type {
  BrowserConsoleEntry,
  BrowserConsoleResult,
  BrowserNetworkEntry,
  BrowserNetworkLogResult
} from '../../../shared/browser/runtime/runtime-browser-contracts'
import { invokeNative, listenNative } from './tauri-native-host'
import { isRecord } from './tauri-native-browser-automation'
import type { PendingNetworkRequest } from './tauri-native-browser-cdp-network-buffer'
import { recordNetworkEvent } from './tauri-native-browser-cdp-network-buffer'

// CDP event tap for the Tauri client host: subscribes log-grade DevTools
// events through the Rust bridge and buffers them per page so automation
// commands can read console/network logs without an event-streaming RPC.
// Buffers are retain-with-cap like agent-browser's session logs; drops set
// the truncated flag instead of failing the read.

export const TAURI_BROWSER_CONSOLE_EVENTS = [
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown'
] as const

export const TAURI_BROWSER_NETWORK_EVENTS = [
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed'
] as const

export const TAURI_BROWSER_INTERCEPT_EVENTS = ['Network.requestWillBeSent'] as const

const MAX_CONSOLE_ENTRIES = 500
const MAX_CONSOLE_TEXT_CHARS = 2000
const DEFAULT_LOG_LIMIT = 100

export type PageLogBuffers = {
  capturing: boolean
  consoleEntries: BrowserConsoleEntry[]
  consoleTruncated: boolean
  networkEntries: BrowserNetworkEntry[]
  networkTruncated: boolean
  networkPending: Map<string, PendingNetworkRequest>
}

const pageBuffers = new Map<string, PageLogBuffers>()
const subscribedEvents = new Set<string>()
let cdpEventListenerInstalled = false

// Per-event sinks for consumers beyond the built-in log buffers (intercept
// observes sent requests here). Sinks run on the native event tick, so they
// must never await before handling.
export type TauriBrowserCdpEventSink = (
  browserPageId: string,
  params: Record<string, unknown>
) => void

const eventSinks = new Map<string, TauriBrowserCdpEventSink>()

export function registerTauriBrowserCdpEventSink(
  event: string,
  sink: TauriBrowserCdpEventSink
): void {
  ensureCdpEventListener()
  eventSinks.set(event, sink)
}

export function unregisterTauriBrowserCdpEventSink(event: string): void {
  eventSinks.delete(event)
}

function buffersFor(browserPageId: string): PageLogBuffers {
  const existing = pageBuffers.get(browserPageId)
  if (existing) {
    return existing
  }
  const created: PageLogBuffers = {
    capturing: false,
    consoleEntries: [],
    consoleTruncated: false,
    networkEntries: [],
    networkTruncated: false,
    networkPending: new Map()
  }
  pageBuffers.set(browserPageId, created)
  return created
}

// CDP timestamps mix wall-ms and monotonic seconds across domains; normalize
// to wall-ms so log consumers see the same clock as the rest of the result.
function normalizeCdpTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return Date.now()
  }
  if (value >= 1_000_000_000_000) {
    return Math.floor(value)
  }
  if (value >= 1_000_000_000) {
    return Math.floor(value * 1000)
  }
  return Date.now()
}

function remoteObjectText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }
  if (isRecord(value)) {
    if (typeof value.description === 'string') {
      return value.description
    }
    if (typeof value.value === 'string') {
      return value.value
    }
  }
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return 'undefined'
  }
}

function firstCallFrame(params: Record<string, unknown>): { url?: string; line?: number } {
  const stackTrace = params.stackTrace
  if (!isRecord(stackTrace)) {
    return {}
  }
  const callFrames = stackTrace.callFrames
  if (!Array.isArray(callFrames)) {
    return {}
  }
  const frame = callFrames.at(0)
  if (!isRecord(frame)) {
    return {}
  }
  const result: { url?: string; line?: number } = {}
  if (typeof frame.url === 'string' && frame.url) {
    result.url = frame.url
  }
  if (typeof frame.lineNumber === 'number') {
    result.line = frame.lineNumber
  }
  return result
}

function appendConsoleEntry(buffers: PageLogBuffers, entry: BrowserConsoleEntry): void {
  buffers.consoleEntries.push(entry)
  if (buffers.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    buffers.consoleEntries.splice(0, buffers.consoleEntries.length - MAX_CONSOLE_ENTRIES)
    buffers.consoleTruncated = true
  }
}

function recordConsoleApiCalled(buffers: PageLogBuffers, params: Record<string, unknown>): void {
  const type = typeof params.type === 'string' ? params.type : 'log'
  const rawArgs = Array.isArray(params.args) ? params.args : []
  const text = rawArgs
    .map((arg) => remoteObjectText(arg))
    .join(' ')
    .slice(0, MAX_CONSOLE_TEXT_CHARS)
  appendConsoleEntry(buffers, {
    level: type,
    text,
    timestamp: normalizeCdpTimestamp(params.timestamp),
    ...firstCallFrame(params)
  })
}

function recordExceptionThrown(buffers: PageLogBuffers, params: Record<string, unknown>): void {
  const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {}
  const exception = isRecord(details.exception) ? details.exception : null
  const description =
    exception && typeof exception.description === 'string'
      ? exception.description
      : typeof details.text === 'string'
        ? details.text
        : 'Uncaught exception'
  appendConsoleEntry(buffers, {
    level: 'error',
    text: description.slice(0, MAX_CONSOLE_TEXT_CHARS),
    timestamp: normalizeCdpTimestamp(params.timestamp),
    ...firstCallFrame(details)
  })
}

function handleCdpEvent(payload: unknown): void {
  if (!isRecord(payload)) {
    return
  }
  const browserPageId = payload.browserPageId
  const event = payload.event
  if (typeof browserPageId !== 'string' || typeof event !== 'string') {
    return
  }
  const params = isRecord(payload.params) ? payload.params : {}
  const buffers = buffersFor(browserPageId)
  // Console and network events buffer only while a capture runs, mirroring
  // the CDP bridge: reads outside a capture see nothing, not stale history.
  if (buffers.capturing) {
    if (event === 'Runtime.consoleAPICalled') {
      recordConsoleApiCalled(buffers, params)
      return
    }
    if (event === 'Runtime.exceptionThrown') {
      recordExceptionThrown(buffers, params)
      return
    }
    if (event.startsWith('Network.')) {
      recordNetworkEvent(buffers, event, params)
    }
  }
  const sink = eventSinks.get(event)
  sink?.(browserPageId, params)
}

function ensureCdpEventListener(): void {
  if (cdpEventListenerInstalled) {
    return
  }
  cdpEventListenerInstalled = true
  listenNative<unknown>('browser:cdp-event', (payload) => {
    handleCdpEvent(payload)
  })
}

export async function subscribeTauriBrowserCdpEvents(
  browserPageId: string,
  events: readonly string[]
): Promise<void> {
  ensureCdpEventListener()
  for (const eventName of events) {
    const key = `${browserPageId}\n${eventName}`
    if (subscribedEvents.has(key)) {
      continue
    }
    await invokeNative<unknown>('poc_browser_cdp_subscribe', {
      args: { browserPageId, eventName }
    }).catch(() => {
      throw new Error('browser_cdp_error')
    })
    subscribedEvents.add(key)
  }
}

function readLimit(limit: unknown): number {
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit)
  }
  return DEFAULT_LOG_LIMIT
}

export function setTauriBrowserPageCapturing(browserPageId: string, capturing: boolean): void {
  buffersFor(browserPageId).capturing = capturing
}

export function clearTauriBrowserPageLogs(browserPageId: string): void {
  const buffers = buffersFor(browserPageId)
  buffers.consoleEntries = []
  buffers.consoleTruncated = false
  buffers.networkEntries = []
  buffers.networkTruncated = false
  buffers.networkPending.clear()
}

export function clearTauriBrowserNetworkPending(browserPageId: string): void {
  buffersFor(browserPageId).networkPending.clear()
}

export function retireTauriBrowserCdpEventsPage(browserPageId: string): void {
  pageBuffers.delete(browserPageId)
}

export function readTauriBrowserConsole(
  browserPageId: string,
  limit?: unknown
): BrowserConsoleResult {
  const buffers = buffersFor(browserPageId)
  const take = readLimit(limit)
  return {
    entries: buffers.consoleEntries.slice(-take),
    truncated: buffers.consoleEntries.length > take || buffers.consoleTruncated
  }
}

export function readTauriBrowserNetworkLog(
  browserPageId: string,
  limit?: unknown
): BrowserNetworkLogResult {
  const buffers = buffersFor(browserPageId)
  const take = readLimit(limit)
  return {
    entries: buffers.networkEntries.slice(-take),
    truncated: buffers.networkEntries.length > take || buffers.networkTruncated
  }
}

export function resetTauriBrowserCdpEventsForTest(): void {
  pageBuffers.clear()
  subscribedEvents.clear()
}
