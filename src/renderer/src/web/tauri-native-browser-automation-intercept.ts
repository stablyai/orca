import type {
  BrowserInterceptDisableResult,
  BrowserInterceptedRequest,
  BrowserInterceptEnableResult
} from '../../../shared/browser/runtime/runtime-browser-contracts'
import type { AutomationCommandContext } from './tauri-native-browser-automation'
import { isRecord } from './tauri-native-browser-automation'
import {
  registerTauriBrowserCdpEventSink,
  subscribeTauriBrowserCdpEvents,
  TAURI_BROWSER_INTERCEPT_EVENTS
} from './tauri-native-browser-cdp-events'

// Observe-only request tap for the Tauri client host. WebView2 delivers
// Fetch.requestPaused without an interceptionId, so a Fetch hold can never
// be continued and would stall the page forever (verified live: the paused
// document never commits and the page session stops answering CDP). The tap
// therefore observes Network.requestWillBeSent without holding anything, and
// keeps the agent-browser list shape and pattern filter. There is still no
// per-request verdict API on this path.

const MAX_INTERCEPT_ENTRIES = 500
const NETWORK_SENT_EVENT = 'Network.requestWillBeSent'

type InterceptPattern = {
  source: string
  regex: RegExp
}

type InterceptState = {
  patterns: string[]
  matchers: InterceptPattern[]
  requests: BrowserInterceptedRequest[]
}

const interceptStates = new Map<string, InterceptState>()
let interceptSinkInstalled = false

function readPatterns(params: Record<string, unknown>): string[] {
  const raw = params.patterns
  if (Array.isArray(raw)) {
    const patterns = raw.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0
    )
    if (patterns.length > 0) {
      return patterns
    }
  }
  const single = params.pattern
  if (typeof single === 'string' && single.length > 0) {
    return [single]
  }
  return ['*']
}

function patternToRegExp(pattern: string): InterceptPattern {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return { source: pattern, regex: new RegExp(`^${escaped}$`) }
}

function matchesPatterns(state: InterceptState, url: string): boolean {
  return state.matchers.some((matcher) => matcher.regex.test(url))
}

function readRequestUrl(params: Record<string, unknown>): { url: string; method: string } {
  const request = isRecord(params.request) ? params.request : {}
  const url = typeof request.url === 'string' ? request.url : ''
  const method = typeof request.method === 'string' ? request.method : 'GET'
  if (url.length > 0) {
    return { url, method }
  }
  if (typeof params.url === 'string') {
    return { url: params.url, method }
  }
  return { url: '', method }
}

function readHeaders(params: Record<string, unknown>): Record<string, string> {
  const request = isRecord(params.request) ? params.request : {}
  const raw = request.headers
  if (!isRecord(raw)) {
    return {}
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      headers[key] = value
    }
  }
  return headers
}

function readResourceType(params: Record<string, unknown>): string {
  if (typeof params.resourceType === 'string') {
    return params.resourceType
  }
  if (typeof params.type === 'string') {
    return params.type
  }
  return 'Other'
}

function handleNetworkRequestSent(browserPageId: string, params: Record<string, unknown>): void {
  const state = interceptStates.get(browserPageId)
  if (!state) {
    return
  }
  const { url, method } = readRequestUrl(params)
  if (url.length === 0 || !matchesPatterns(state, url)) {
    return
  }
  const requestId = params.requestId
  state.requests.push({
    id: typeof requestId === 'string' && requestId.length > 0 ? requestId : url,
    url,
    method,
    headers: readHeaders(params),
    resourceType: readResourceType(params)
  })
  if (state.requests.length > MAX_INTERCEPT_ENTRIES) {
    state.requests.splice(0, state.requests.length - MAX_INTERCEPT_ENTRIES)
  }
}

function ensureInterceptSink(): void {
  if (interceptSinkInstalled) {
    return
  }
  interceptSinkInstalled = true
  registerTauriBrowserCdpEventSink(NETWORK_SENT_EVENT, handleNetworkRequestSent)
}

export async function interceptAutomationEnable(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<BrowserInterceptEnableResult> {
  const patterns = readPatterns(params)
  await subscribeTauriBrowserCdpEvents(context.browserPageId, TAURI_BROWSER_INTERCEPT_EVENTS)
  await context.send('Network.enable', {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
  ensureInterceptSink()
  interceptStates.set(context.browserPageId, {
    patterns,
    matchers: patterns.map(patternToRegExp),
    requests: []
  })
  return { enabled: true, patterns }
}

export async function interceptAutomationDisable(
  context: AutomationCommandContext
): Promise<BrowserInterceptDisableResult> {
  // No Network.disable here: the domain is shared with capture, and leaving
  // it enabled is harmless. Dropping the state is what stops recording.
  interceptStates.delete(context.browserPageId)
  return { disabled: true }
}

export function interceptAutomationList(context: AutomationCommandContext): {
  requests: BrowserInterceptedRequest[]
} {
  const state = interceptStates.get(context.browserPageId)
  return { requests: state ? [...state.requests] : [] }
}

export function retireTauriBrowserIntercept(browserPageId: string): void {
  interceptStates.delete(browserPageId)
}

export function resetTauriBrowserInterceptForTest(): void {
  interceptStates.clear()
}
