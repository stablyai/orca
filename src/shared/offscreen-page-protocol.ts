import { z } from 'zod'

/** Custom element that stands in for <webview> when a browser page renders offscreen. */
export const OFFSCREEN_PAGE_TAG = 'orca-offscreen-page'
export type { OffscreenPageDatalistItem } from './offscreen-page-guest-channels'
import type { OffscreenPageDatalistItem } from './offscreen-page-guest-channels'

/** The datalist popup Orca draws over the page, in host CSS px relative to the page element. */
export type OffscreenPageDatalist = {
  rect: { x: number; y: number; width: number; height: number }
  /** Host CSS px per page DIP, so rows keep the popup's native size. */
  scale: number
  items: OffscreenPageDatalistItem[]
  selected: number | null
  dark: boolean
}

// Why a closed schema: the renderer is the only sender, but it is still a separate process — main
// validates every event before it reaches sendInputEvent or the page's debugger.

const modifiers = z.array(z.enum(['shift', 'control', 'alt', 'meta'])).max(4)
const coordinate = z.number().finite()

export const OffscreenPageUserInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    type: z.enum(['mouseDown', 'mouseUp', 'mouseMove', 'mouseEnter', 'mouseLeave']),
    x: coordinate,
    y: coordinate,
    button: z.enum(['left', 'middle', 'right', 'back', 'forward']).default('left'),
    clickCount: z.number().int().min(0).max(3).default(1),
    modifiers: modifiers.default([]),
    // Why: pages read MouseEvent.buttons during moves (sliders, drawing, panning).
    heldButtons: z
      .array(z.enum(['left', 'middle', 'right']))
      .max(3)
      .default([])
  }),
  z.object({
    kind: z.literal('wheel'),
    x: coordinate,
    y: coordinate,
    deltaX: coordinate,
    deltaY: coordinate,
    modifiers: modifiers.default([])
  }),
  // A DOM KeyboardEvent as Orca's window saw it; `text` is what the key types, '' for none.
  z.object({
    kind: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp']),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    keyCode: z.number().int().min(0).max(255),
    location: z.number().int().min(0).max(3),
    repeat: z.boolean(),
    text: z.string().max(8),
    modifiers: modifiers.default([])
  }),
  // IME composition in progress: shown underlined in the page, not yet committed.
  z.object({
    kind: z.literal('compose'),
    text: z.string().max(256),
    selectionStart: z.number().int().min(0),
    selectionEnd: z.number().int().min(0)
  }),
  z.object({ kind: z.literal('commit'), text: z.string().max(64 * 1024) }),
  z.object({ kind: z.literal('cancelComposition') })
])

export type OffscreenPageUserInput = z.infer<typeof OffscreenPageUserInputSchema>

export const OffscreenPageViewportSchema = z.object({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  visible: z.boolean()
})

export type OffscreenPageViewport = z.infer<typeof OffscreenPageViewportSchema>

/** Page-space rect of the text caret, used to park the hidden IME textarea under it. */
export type OffscreenPageCaret = { x: number; y: number; height: number }

/** Border box of an open <select>; page CSS px from main, element-relative CSS px to the renderer. */
export type OffscreenPageSelectAnchor = { x: number; y: number; width: number; height: number }

/** OS files dropped on the page, at host CSS px relative to the page element. */
export const OffscreenPageFileDropSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  files: z.array(z.string().min(1).max(4096)).min(1).max(256)
})
export type OffscreenPageFileDrop = z.infer<typeof OffscreenPageFileDropSchema>

/** Where the renderer wants an open select's menu, in its own window-client CSS px. */
export const OffscreenPageSelectMenuPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
})

/** Snapshot that backs the renderer element's synchronous webview-style getters. */
export type OffscreenPageGuestState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  zoomLevel: number
}

export type OffscreenPageGuestEvent = {
  type:
    | 'dom-ready'
    | 'did-start-loading'
    | 'did-stop-loading'
    | 'did-start-navigation'
    | 'did-redirect-navigation'
    | 'did-navigate'
    | 'did-navigate-in-page'
    | 'load-commit'
    | 'page-title-updated'
    | 'page-favicon-updated'
    | 'did-fail-load'
    | 'console-message'
    | 'found-in-page'
    | 'render-process-gone'
    | 'destroyed'
    // Orca-only: refreshes the element's state cache without firing a DOM event.
    | 'state'
  detail: Record<string, unknown>
  /** Absent only on `destroyed`, when there is no page left to read. */
  state?: OffscreenPageGuestState
}

/** Commands the renderer element issues on behalf of webview-style method calls. */
export const OffscreenPageCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('loadURL'), url: z.string().max(32 * 1024) }),
  z.object({ kind: z.literal('goBack') }),
  z.object({ kind: z.literal('goForward') }),
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('reloadIgnoringCache') }),
  z.object({ kind: z.literal('stop') }),
  z.object({ kind: z.literal('setZoomLevel'), level: z.number().finite().min(-10).max(10) }),
  z.object({
    kind: z.literal('findInPage'),
    text: z.string().min(1).max(1024),
    forward: z.boolean().optional(),
    findNext: z.boolean().optional(),
    matchCase: z.boolean().optional()
  }),
  // Why: on macOS Edit-menu roles act on the focused window, which is Orca's, never the offscreen page.
  z.object({
    kind: z.literal('edit'),
    action: z.enum(['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo'])
  }),
  z.object({
    kind: z.literal('stopFindInPage'),
    action: z.enum(['clearSelection', 'keepSelection', 'activateSelection'])
  })
])

export type OffscreenPageCommand = z.infer<typeof OffscreenPageCommandSchema>
