/** An opted-in desktop serves a managed SSH host’s CLI browser requests. Both peers must advertise desktopBridge.v1; unsupported peers refuse with unavailable instead of hanging. */
import { z } from 'zod'

export const DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY = 'browser.desktopBridge.v1'
/** Send cancel only when negotiated: older desktops drop the whole attachment on unknown event types. */
export const DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY = 'browser.desktopBridge.cancel.v1'

export const DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE = 'desktop_browser_bridge_unavailable'
export const DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE = 'desktop_browser_bridge_not_forwarded'
export const DESKTOP_BROWSER_BRIDGE_SCOPE_CODE = 'desktop_browser_bridge_out_of_scope'
export const DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE = 'desktop_browser_bridge_unrouted'

export const DESKTOP_BROWSER_BRIDGE_SETTING_LABEL = "Allow this host's orca CLI to control Orca"

/** The desktop also withholds the bridge while this host's pages browse from the desktop's own network. */
export const DESKTOP_BROWSER_BRIDGE_ROUTING_SETTING_LABEL = 'Settings › Browser › SSH workspaces'
export const DESKTOP_BROWSER_BRIDGE_ROUTING_OPT_OUT_LABEL =
  'Hosts browsing from this device instead'

export const DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE = `No Orca desktop is sharing its browser with this host. On your desktop, open this host's SSH settings and turn on "${DESKTOP_BROWSER_BRIDGE_SETTING_LABEL}", make sure ${DESKTOP_BROWSER_BRIDGE_ROUTING_SETTING_LABEL} is "SSH host" and this host isn't listed under "${DESKTOP_BROWSER_BRIDGE_ROUTING_OPT_OUT_LABEL}", and keep the host connected. The desktop needs an Orca version that supports it.`

/** Unlike the pre-1.4.225 arbitrary CLI relay, allow browser commands only: no desktop files, clipboard, cookies/headers, raw agent-browser, profile/identity changes or certificate bypass. */
export const DESKTOP_BROWSER_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'browser.tabList',
  'browser.tabCurrent',
  'browser.tabShow',
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
  'browser.dialogDismiss'
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
  message: z.string().max(4096)
})

export const DesktopBrowserBridgeResultParams = z.discriminatedUnion('ok', [
  z.object({
    attachmentId: Identity,
    requestId: Identity,
    ok: z.literal(true),
    result: z.unknown()
  }),
  z.object({
    attachmentId: Identity,
    requestId: Identity,
    ok: z.literal(false),
    error: BridgeError
  })
])
export type DesktopBrowserBridgeResultParams = z.infer<typeof DesktopBrowserBridgeResultParams>
