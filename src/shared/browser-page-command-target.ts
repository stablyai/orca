import type { WindowShortcutInput } from './window-shortcut-policy'

/** The page a guest-forwarded chrome chord (reload, history, address bar) is aimed at. */
export type BrowserPageCommandTarget = {
  browserPageId: string
}

export type BrowserHistoryNavigateCommand = BrowserPageCommandTarget & {
  direction: 'back' | 'forward'
}

/** A tab chord a focused page hands back to Orca; the renderer replays it as a key event. */
export type BrowserPageTabShortcut = Pick<
  WindowShortcutInput,
  'key' | 'code' | 'alt' | 'meta' | 'control' | 'shift' | 'doubleTapModifier'
>
