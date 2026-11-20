import { buildSnapshot, type RefEntry } from '../../../main/browser/cdp/snapshots/snapshot-engine'
import type { BrowserClientAutomationMethod } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { normalizeBrowserNavigationUrl } from '../../../shared/browser/navigation/browser-url'
import type { BrowserSnapshotResult } from '../../../shared/runtime-browser-contracts'
import { invokeNative } from './tauri-native-host'
import { getTauriNativeBrowserPageInfo } from './tauri-native-browser-webview'
import { runTauriBrowserAutomationCommand } from './tauri-native-browser-automation-commands'
import {
  createTauriSessionCdpSender,
  ensureTauriIframeTracking,
  listTauriIframeSessions,
  retireTauriIframeSessions
} from './tauri-native-browser-iframe-sessions'
import { retireTauriBrowserIntercept } from './tauri-native-browser-automation-intercept'
import { retireTauriBrowserCdpEventsPage } from './tauri-native-browser-cdp-events'

export type TauriCdpSender = (method: string, params?: Record<string, unknown>) => Promise<unknown>

type PageAutomationState = {
  generation: number
  refs: Map<string, RefEntry>
}

const pageStates = new Map<string, PageAutomationState>()

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

export function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}

export function requireString(params: Record<string, unknown>, key: string): string {
  const value = readString(params, key)
  if (value === undefined) {
    throw new Error('browser_invalid_params')
  }
  return value
}

export function createTauriCdpSender(browserPageId: string): TauriCdpSender {
  return async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const envelope = await invokeNative<unknown>('poc_browser_cdp', {
      args: { browserPageId, method, params }
    }).catch(() => {
      throw new Error('browser_cdp_error')
    })
    if (!isRecord(envelope)) {
      throw new Error('browser_cdp_error')
    }
    if (isRecord(envelope.error)) {
      throw new Error('browser_cdp_error')
    }
    // The native pipe returns the raw CDP method result (single-wrapped:
    // Runtime.evaluate arrives as { result: RemoteObject }), so no level is
    // stripped here. Stripping one broke every response.result reader live
    // while double-wrapped mocks kept the tests green.
    return envelope
  }
}

export type AutomationCommandContext = {
  browserPageId: string
  send: TauriCdpSender
  refs: Map<string, RefEntry>
}

export function resolveAutomationRef(refs: Map<string, RefEntry>, element: string): RefEntry {
  const entry = refs.get(element)
  if (!entry) {
    throw new Error('browser_ref_not_found')
  }
  return entry
}

export async function resolveElementObjectId(
  send: TauriCdpSender,
  entry: RefEntry
): Promise<string> {
  const resolved = await send('DOM.resolveNode', {
    backendNodeId: entry.backendDOMNodeId
  }).catch(() => {
    throw new Error('browser_ref_not_found')
  })
  if (!isRecord(resolved) || !isRecord(resolved.object)) {
    throw new Error('browser_ref_not_found')
  }
  const objectId = resolved.object.objectId
  if (typeof objectId !== 'string' || objectId.length === 0) {
    throw new Error('browser_ref_not_found')
  }
  return objectId
}

export async function evaluatePageExpression(
  send: TauriCdpSender,
  expression: string
): Promise<unknown> {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }).catch(() => {
    throw new Error('browser_eval_error')
  })
  if (!isRecord(response)) {
    throw new Error('browser_eval_error')
  }
  if (response.exceptionDetails !== undefined) {
    throw new Error('browser_eval_error')
  }
  const result = response.result
  if (!isRecord(result)) {
    return null
  }
  return result.value ?? null
}

export async function snapshotTauriBrowserPage(
  browserPageId: string,
  generation: number
): Promise<BrowserSnapshotResult> {
  const send = createTauriCdpSender(browserPageId)
  // Iframe enrichment never breaks the core snapshot: without tracking the
  // page tree still builds, and a dead pipe fails loudly one line below.
  await ensureTauriIframeTracking(browserPageId, send).catch(() => undefined)
  const iframeSessions = listTauriIframeSessions(browserPageId)
  const built = await buildSnapshot(send, iframeSessions, (sessionId) =>
    createTauriSessionCdpSender(browserPageId, sessionId)
  ).catch(() => {
    throw new Error('browser_cdp_error')
  })
  pageStates.set(browserPageId, { generation, refs: built.refMap })
  const info = getTauriNativeBrowserPageInfo(browserPageId)
  return {
    browserPageId,
    snapshot: built.snapshot,
    refs: built.refs,
    url: info?.url ?? '',
    title: info?.title ?? ''
  }
}

export function retireTauriBrowserClientAutomation(
  browserPageId: string,
  generation?: number
): void {
  const state = pageStates.get(browserPageId)
  if (!state) {
    return
  }
  if (generation !== undefined && state.generation !== generation) {
    return
  }
  pageStates.delete(browserPageId)
  retireTauriBrowserIntercept(browserPageId)
  retireTauriBrowserCdpEventsPage(browserPageId)
  retireTauriIframeSessions(browserPageId)
}

export async function ensureTauriBrowserAutomationContext(
  browserPageId: string,
  generation: number
): Promise<AutomationCommandContext> {
  const current = pageStates.get(browserPageId)
  if (!current || current.generation !== generation) {
    await snapshotTauriBrowserPage(browserPageId, generation)
  }
  const state = pageStates.get(browserPageId)
  if (!state) {
    throw new Error('browser_cdp_error')
  }
  return { browserPageId, send: createTauriCdpSender(browserPageId), refs: state.refs }
}

export function normalizeAutomationNavigationUrl(url: string): string {
  const normalized = normalizeBrowserNavigationUrl(url)
  if (!normalized) {
    throw new Error('browser_invalid_params')
  }
  return normalized
}

export async function executeTauriBrowserClientAutomation(
  browserPageId: string,
  generation: number,
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown>
): Promise<unknown> {
  if (method === 'browser.snapshot') {
    return snapshotTauriBrowserPage(browserPageId, generation)
  }
  const context = await ensureTauriBrowserAutomationContext(browserPageId, generation)
  return runTauriBrowserAutomationCommand(context, method, params)
}

export function readAutomationPageInfo(browserPageId: string): { url: string; title: string } {
  const info = getTauriNativeBrowserPageInfo(browserPageId)
  return { url: info?.url ?? '', title: info?.title ?? '' }
}
