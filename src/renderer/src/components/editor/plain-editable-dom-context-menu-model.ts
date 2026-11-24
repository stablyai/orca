import { handleAppMenuPasteRequest } from '@/lib/clipboard/menu/app-menu-paste'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { isTauriNativeHost } from '../../web/tauri-native-host'

export type PlainEditableDomMenuAction = 'cut' | 'copy' | 'paste' | 'paste-plain' | 'select-all'

export type PlainEditableDomMenuEntry =
  | { kind: 'edit'; action: PlainEditableDomMenuAction; label: string; disabled?: boolean }
  | { kind: 'separator' }

// Why: Tauri/WebView2 cannot show Electron's native context menu and the
// paired web client has no main process at all, so both render this DOM menu.
export function shouldUsePlainEditableDomContextMenu(): boolean {
  return isTauriNativeHost() || isWebClientLocation()
}

// Why: keep the same items and order as buildNativeEditMenuTemplate in
// src/main/window/editable-context-menu.ts so the DOM menu is a transport
// replacement, not a second menu design.
export function buildPlainEditableDomContextMenuModel(options: {
  hasSelection: boolean
  readOnly: boolean
  t?: (key: string, defaultValue: string) => string
}): PlainEditableDomMenuEntry[] {
  const { hasSelection, readOnly, t = translate } = options
  return [
    {
      kind: 'edit',
      action: 'cut',
      label: t('auto.components.editor.PlainEditableDomContextMenu.cut', 'Cut'),
      disabled: !hasSelection || readOnly
    },
    {
      kind: 'edit',
      action: 'copy',
      label: t('auto.components.editor.PlainEditableDomContextMenu.copy', 'Copy'),
      disabled: !hasSelection
    },
    {
      kind: 'edit',
      action: 'paste',
      label: t('auto.components.editor.PlainEditableDomContextMenu.paste', 'Paste'),
      disabled: readOnly
    },
    {
      kind: 'edit',
      action: 'paste-plain',
      label: t(
        'auto.components.editor.PlainEditableDomContextMenu.pasteAsPlainText',
        'Paste as plain text'
      ),
      disabled: readOnly
    },
    {
      kind: 'edit',
      action: 'select-all',
      label: t('auto.components.editor.PlainEditableDomContextMenu.selectAll', 'Select all'),
      disabled: false
    }
  ]
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'password', 'url', 'tel', 'email', 'number'])

// Why: the rich markdown editor and the terminal own their own menus, so the
// global plain-editable menu never claims their surfaces.
export function findPlainEditableContextMenuTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null
  }
  if (target.closest('.tiptap, .xterm') !== null) {
    return null
  }
  const editable = target.closest('input, textarea')
  if (!(editable instanceof HTMLElement)) {
    return null
  }
  if (editable instanceof HTMLInputElement) {
    if (!TEXT_INPUT_TYPES.has(editable.type) || editable.disabled) {
      return null
    }
    return editable
  }
  if (editable instanceof HTMLTextAreaElement) {
    return editable.disabled ? null : editable
  }
  return null
}

export function readPlainEditableTargetState(target: HTMLElement): {
  hasSelection: boolean
  readOnly: boolean
} {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    let hasSelection = false
    try {
      hasSelection = (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0)
    } catch {
      hasSelection = false
    }
    return { hasSelection, readOnly: target.readOnly }
  }
  const selection = window.getSelection()
  return {
    hasSelection:
      selection !== null && !selection.isCollapsed && target.contains(selection.anchorNode),
    readOnly: false
  }
}

// Why: mirror the Electron native roles (cut/copy/select-all) and the
// editableContextPaste IPC path (paste) so clipboard behavior matches.
export function runPlainEditableDomMenuEditAction(
  target: HTMLElement,
  action: PlainEditableDomMenuAction
): void {
  switch (action) {
    case 'select-all':
      target.focus()
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.select()
        return
      }
      document.execCommand?.('selectAll')
      return
    case 'cut':
    case 'copy':
      target.focus()
      document.execCommand?.(action)
      return
    case 'paste':
    case 'paste-plain':
      target.focus()
      void handleAppMenuPasteRequest({
        readClipboardText: window.api.ui.readClipboardText,
        performNativePaste: window.api.ui.performNativePaste,
        nativePasteMode: action === 'paste-plain' ? 'paste-and-match-style' : 'paste'
      }).catch(() => undefined)
  }
}

// Why: the plain menu is flat (Electron nests nothing here), so focus is a
// single wrapping index over the enabled entries, skipping separators and
// disabled items like the native menu does.
export function initialPlainEditableDomMenuFocus(
  entries: PlainEditableDomMenuEntry[]
): number | null {
  const first = entries.findIndex((entry) => entry.kind !== 'separator' && entry.disabled !== true)
  return first === -1 ? null : first
}

export function movePlainEditableDomMenuFocus(options: {
  entries: PlainEditableDomMenuEntry[]
  focus: number | null
  direction: 1 | -1
}): number | null {
  const enabled: number[] = []
  for (let index = 0; index < options.entries.length; index++) {
    const entry = options.entries[index]
    if (entry.kind !== 'separator' && entry.disabled !== true) {
      enabled.push(index)
    }
  }
  if (enabled.length === 0) {
    return options.focus
  }
  const current = options.focus === null ? -1 : enabled.indexOf(options.focus)
  return enabled[(current + options.direction + enabled.length) % enabled.length]
}
