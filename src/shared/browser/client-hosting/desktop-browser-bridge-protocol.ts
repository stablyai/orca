/** An opted-in desktop serves a managed SSH host’s CLI browser requests. Both peers must advertise desktopBridge.v1; unsupported peers refuse with unavailable instead of hanging. */
import { z } from 'zod'
import {
  BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES
} from './browser-client-automation-protocol'
import { DESKTOP_BROWSER_BRIDGE_FILE_TRANSFER_CAPABILITY } from './desktop-browser-bridge-file-transfer-protocol'

export const DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY = 'browser.desktopBridge.v1'
/** Send cancel only when negotiated: older desktops drop the whole attachment on unknown event types. */
export const DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY = 'browser.desktopBridge.cancel.v1'
/** Older desktops re-parse params and would drop expectUrl, so commands carrying it need this. */
export const DESKTOP_BROWSER_BRIDGE_EXPECT_URL_CAPABILITY = 'browser.desktopBridge.expect-url.v1'
/** Older desktops drop the whole attachment on a method they don't allow, so tab annotations need this. */
export const DESKTOP_BROWSER_BRIDGE_TAB_ANNOTATIONS_CAPABILITY =
  'browser.desktopBridge.tab-annotations.v1'
/** Same reason: pdf, network log, device/media/offline/geolocation emulation and page storage need this. */
export const DESKTOP_BROWSER_BRIDGE_PAGE_TOOLS_CAPABILITY = 'browser.desktopBridge.page-tools.v1'
/** Older desktops drop tab create's activate, so `tab create --focus` needs this. */
export const DESKTOP_BROWSER_BRIDGE_TAB_CREATE_FOCUS_CAPABILITY =
  'browser.desktopBridge.tab-create-focus.v1'

export const DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE = 'desktop_browser_bridge_unavailable'
export const DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE = 'desktop_browser_bridge_not_forwarded'
export const DESKTOP_BROWSER_BRIDGE_SCOPE_CODE = 'desktop_browser_bridge_out_of_scope'
export const DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE = 'desktop_browser_bridge_unrouted'

export const DESKTOP_BROWSER_BRIDGE_SETTING_LABEL =
  'Allow this host to control Orca browser tabs in its workspaces'

/** The desktop also withholds the bridge while this host's pages browse from the desktop's own network. */
export const DESKTOP_BROWSER_BRIDGE_ROUTING_SETTING_LABEL = 'Settings › Browser › SSH workspaces'
export const DESKTOP_BROWSER_BRIDGE_ROUTING_OPT_OUT_LABEL =
  'Hosts browsing from this device instead'

export const DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE = `No Orca desktop is sharing its browser with this host. On your desktop, open this host's SSH settings and turn on "${DESKTOP_BROWSER_BRIDGE_SETTING_LABEL}", make sure ${DESKTOP_BROWSER_BRIDGE_ROUTING_SETTING_LABEL} is "SSH host" and this host isn't listed under "${DESKTOP_BROWSER_BRIDGE_ROUTING_OPT_OUT_LABEL}", and keep the host connected. The desktop needs an Orca version that supports it.`

const PAGE_TOOLS_METHODS = [
  'browser.pdf',
  'browser.network',
  'browser.setDevice',
  'browser.setMedia',
  'browser.setOffline',
  'browser.geolocation',
  'browser.storage.local.get',
  'browser.storage.local.set',
  'browser.storage.local.clear',
  'browser.storage.session.get',
  'browser.storage.session.set',
  'browser.storage.session.clear'
] as const

/** Methods an older desktop refuses, mapped to the capability a desktop declares when it serves them. */
export const DESKTOP_BROWSER_BRIDGE_METHOD_CAPABILITIES: ReadonlyMap<string, string> = new Map([
  ['browser.tabAnnotations', DESKTOP_BROWSER_BRIDGE_TAB_ANNOTATIONS_CAPABILITY],
  ['browser.upload', DESKTOP_BROWSER_BRIDGE_FILE_TRANSFER_CAPABILITY],
  ['browser.download', DESKTOP_BROWSER_BRIDGE_FILE_TRANSFER_CAPABILITY],
  ...PAGE_TOOLS_METHODS.map(
    (method) => [method, DESKTOP_BROWSER_BRIDGE_PAGE_TOOLS_CAPABILITY] as const
  )
])

/** Unlike the pre-1.4.225 arbitrary CLI relay, allow browser commands only: no desktop files, clipboard, cookies/headers, raw agent-browser, profile/identity changes or certificate bypass. Upload and download move the host's own files, never the desktop's. */
export const DESKTOP_BROWSER_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'browser.tabList',
  'browser.tabCurrent',
  'browser.tabShow',
  'browser.tabAnnotations',
  'browser.tabSwitch',
  'browser.tabCreate',
  'browser.tabClose',
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.snapshot',
  'browser.screenshot',
  'browser.fullScreenshot',
  'browser.get',
  'browser.is',
  'browser.find',
  'browser.wait',
  'browser.eval',
  'browser.console',
  'browser.click',
  'browser.dblclick',
  'browser.fill',
  'browser.type',
  'browser.select',
  'browser.check',
  'browser.focus',
  'browser.clear',
  'browser.selectAll',
  'browser.hover',
  'browser.drag',
  'browser.scroll',
  'browser.scrollIntoView',
  'browser.highlight',
  'browser.keypress',
  'browser.keyboardInsertText',
  'browser.mouseMove',
  'browser.mouseDown',
  'browser.mouseUp',
  'browser.mouseClick',
  'browser.mouseWheel',
  'browser.viewport',
  'browser.dialogAccept',
  'browser.dialogDismiss',
  'browser.upload',
  'browser.download',
  ...PAGE_TOOLS_METHODS
])

/** Main asks the renderer, which owns the workspace-to-host map, what a host may reach. */
export type RemoteCliBrowserScopeQuery = {
  requestId: string
  environmentId: string
  workspaceId?: string
  pageId?: string
}

/** The workspace the host may use for this command, or null to refuse it. */
export type RemoteCliBrowserScopeReply = { requestId: string; workspaceId: string | null }

export function isDesktopBrowserBridgeMethod(method: string): boolean {
  return DESKTOP_BROWSER_BRIDGE_METHODS.has(method)
}

const Identity = z.string().min(1).max(256)
const MAX_FORWARDED_PARAMS_BYTES = 1024 * 1024
const MAX_WORKSPACE_ID_LENGTH = 16 * 1024

export const DesktopBrowserBridgeAttachParams = z.object({
  bridgeClientId: Identity
})

export const DesktopBrowserBridgeRequest = z.object({
  type: z.literal('request'),
  requestId: Identity,
  method: z.string().refine(isDesktopBrowserBridgeMethod, 'method is not forwarded'),
  /** How long orcad waits for this answer; the desktop never starts the command after it. */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60_000)
    .optional(),
  /** The workspace orcad resolved the caller's selector to; absent when it named none. */
  // Why longer than an identity: a worktree id embeds the repository's absolute path.
  workspaceId: z.string().min(1).max(MAX_WORKSPACE_ID_LENGTH).optional(),
  /** orcad accepts desktopBrowserBridge.resultChunk; older ones omit it and older desktops ignore it. */
  stagedResults: z.literal(true).optional(),
  params: z
    .record(z.string(), z.unknown())
    .refine(
      (value) => JSON.stringify(value).length <= MAX_FORWARDED_PARAMS_BYTES,
      'params exceed the forwarded size budget'
    )
})
export type DesktopBrowserBridgeRequest = z.infer<typeof DesktopBrowserBridgeRequest>

export const DesktopBrowserBridgeEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), attachmentId: Identity }),
  DesktopBrowserBridgeRequest,
  /** orcad stopped waiting for this request; the desktop must not start or continue it. */
  z.object({ type: z.literal('cancel'), requestId: Identity })
])
export type DesktopBrowserBridgeEvent = z.infer<typeof DesktopBrowserBridgeEvent>

const BridgeError = z.object({
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
  data: z.unknown().optional()
})

export const DesktopBrowserBridgeResultParams = z.discriminatedUnion('ok', [
  z.object({
    attachmentId: Identity,
    requestId: Identity,
    ok: z.literal(true),
    result: z.unknown(),
    /** The value went ahead in resultChunk calls; result is null. */
    stagedResultBytes: z
      .number()
      .int()
      .positive()
      .max(BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES)
      .optional()
  }),
  z.object({
    attachmentId: Identity,
    requestId: Identity,
    ok: z.literal(false),
    error: BridgeError
  })
])
export type DesktopBrowserBridgeResultParams = z.infer<typeof DesktopBrowserBridgeResultParams>

/** One piece of a result too large for a single frame, sent in order before the result. */
export const DesktopBrowserBridgeResultChunkParams = z.object({
  attachmentId: Identity,
  requestId: Identity,
  offset: z.number().int().nonnegative().max(BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES),
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil(BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
})
export type DesktopBrowserBridgeResultChunkParams = z.infer<
  typeof DesktopBrowserBridgeResultChunkParams
>

// Routed tabs can still display local files; those remain off-limits to hosts.
// Allow chrome-error: so hosts can navigate away from failed loads.
const HOST_REACHABLE_DOCUMENT_PROTOCOLS = new Set([
  'http:',
  'https:',
  'about:',
  'blob:',
  'data:',
  'chrome-error:'
])

export function isHostReachableDocument(url: string): boolean {
  try {
    return HOST_REACHABLE_DOCUMENT_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return url === ''
  }
}
