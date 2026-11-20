import type { Editor } from '@tiptap/react'
import { translate } from '@/i18n/i18n'
import { handleAppMenuPasteRequest } from '@/lib/clipboard/menu/app-menu-paste'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { isTauriNativeHost } from '../../web/tauri-native-host'
import type { RichMarkdownContextMenuCommand } from '../../../../shared/editor/markdown/rich-markdown-context-menu'

export type RichMarkdownDomMenuCellType = 'body' | 'header'

export type RichMarkdownDomMenuEditAction = 'cut' | 'copy' | 'paste' | 'paste-plain' | 'select-all'

export type RichMarkdownDomMenuEntry =
  | { kind: 'command'; command: RichMarkdownContextMenuCommand; label: string; disabled?: boolean }
  | { kind: 'edit'; action: RichMarkdownDomMenuEditAction; label: string; disabled?: boolean }
  | { kind: 'submenu'; label: string; items: RichMarkdownDomMenuEntry[] }
  | { kind: 'separator' }

// Why: Tauri/WebView2 cannot show Electron's native context menu and the
// paired web client has no main process at all, so both render this DOM menu.
export function shouldUseRichMarkdownDomContextMenu(): boolean {
  return isTauriNativeHost() || isWebClientLocation()
}

// Why: keep the same items, order, labels, and header-row disabled states as
// buildMarkdownMenuTemplate in src/main/window/editable-context-menu.ts so
// the DOM menu is a transport replacement, not a second menu design.
export function buildRichMarkdownDomContextMenuModel(options: {
  cellType: RichMarkdownDomMenuCellType | null
  hasSelection: boolean
}): RichMarkdownDomMenuEntry[] {
  const { cellType, hasSelection } = options
  const inHeaderRow = cellType === 'header'
  return [
    { kind: 'command', command: 'add-link', label: 'Add link' },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: 'Format',
      items: [
        { kind: 'command', command: 'bold', label: 'Bold' },
        { kind: 'command', command: 'italic', label: 'Italic' },
        { kind: 'command', command: 'strike', label: 'Strike' },
        { kind: 'command', command: 'inline-code', label: 'Inline code' },
        { kind: 'command', command: 'code-block', label: 'Code block' },
        { kind: 'command', command: 'blockquote', label: 'Quote' }
      ]
    },
    {
      kind: 'submenu',
      label: 'Paragraph',
      items: [
        { kind: 'command', command: 'paragraph', label: 'Body text' },
        { kind: 'command', command: 'heading-1', label: 'Heading 1' },
        { kind: 'command', command: 'heading-2', label: 'Heading 2' },
        { kind: 'command', command: 'heading-3', label: 'Heading 3' },
        { kind: 'command', command: 'heading-4', label: 'Heading 4' },
        { kind: 'command', command: 'heading-5', label: 'Heading 5' },
        { kind: 'separator' },
        { kind: 'command', command: 'bullet-list', label: 'Bullet list' },
        { kind: 'command', command: 'ordered-list', label: 'Numbered list' },
        { kind: 'command', command: 'task-list', label: 'Checklist' }
      ]
    },
    {
      kind: 'submenu',
      label: 'Insert',
      items: [
        { kind: 'command', command: 'add-link', label: 'Link' },
        { kind: 'command', command: 'image', label: 'Image' },
        { kind: 'command', command: 'divider', label: 'Divider' },
        { kind: 'command', command: 'code-block', label: 'Code block' }
      ]
    },
    ...(cellType
      ? [
          {
            kind: 'submenu' as const,
            label: translate('auto.main.window.editableContextMenu.table', 'Table'),
            items: [
              {
                kind: 'command' as const,
                command: 'insert-row-above' as const,
                label: translate(
                  'auto.main.window.editableContextMenu.insertRowAbove',
                  'Insert row above'
                ),
                disabled: inHeaderRow
              },
              {
                kind: 'command' as const,
                command: 'insert-row-below' as const,
                label: translate(
                  'auto.main.window.editableContextMenu.insertRowBelow',
                  'Insert row below'
                )
              },
              {
                kind: 'command' as const,
                command: 'delete-row' as const,
                label: translate('auto.main.window.editableContextMenu.deleteRow', 'Delete row'),
                disabled: inHeaderRow
              },
              { kind: 'separator' as const },
              {
                kind: 'command' as const,
                command: 'insert-column-left' as const,
                label: translate(
                  'auto.main.window.editableContextMenu.insertColumnLeft',
                  'Insert column left'
                )
              },
              {
                kind: 'command' as const,
                command: 'insert-column-right' as const,
                label: translate(
                  'auto.main.window.editableContextMenu.insertColumnRight',
                  'Insert column right'
                )
              },
              {
                kind: 'command' as const,
                command: 'delete-column' as const,
                label: translate(
                  'auto.main.window.editableContextMenu.deleteColumn',
                  'Delete column'
                )
              },
              { kind: 'separator' as const },
              {
                kind: 'command' as const,
                command: 'delete-table' as const,
                label: translate('auto.main.window.editableContextMenu.deleteTable', 'Delete table')
              }
            ]
          }
        ]
      : []),
    { kind: 'separator' },
    { kind: 'edit', action: 'cut', label: 'Cut', disabled: !hasSelection },
    { kind: 'edit', action: 'copy', label: 'Copy', disabled: !hasSelection },
    { kind: 'edit', action: 'paste', label: 'Paste' },
    { kind: 'edit', action: 'paste-plain', label: 'Paste as plain text' },
    { kind: 'edit', action: 'select-all', label: 'Select all' }
  ]
}

// Why: mirror the Electron native roles (cut/copy/select-all) and the
// editableContextPaste IPC path (paste) so clipboard behavior matches.
export function runRichMarkdownDomMenuEditAction(
  editor: Editor,
  action: RichMarkdownDomMenuEditAction
): void {
  switch (action) {
    case 'cut':
      editor.view.focus()
      document.execCommand?.('cut')
      return
    case 'copy':
      editor.view.focus()
      document.execCommand?.('copy')
      return
    case 'select-all':
      editor.chain().focus().selectAll().run()
      return
    case 'paste':
    case 'paste-plain':
      void handleAppMenuPasteRequest({
        readClipboardText: window.api.ui.readClipboardText,
        performNativePaste: window.api.ui.performNativePaste,
        nativePasteMode: action === 'paste-plain' ? 'paste-and-match-style' : 'paste'
      }).catch(() => undefined)
  }
}

// Why: Electron's native menu is fully keyboard operable, so the DOM
// replacement tracks the same focus model: one level at a time (top level or
// the open submenu), wrapping past the ends and skipping separators and
// disabled entries.
export type RichMarkdownDomMenuFocus = {
  inSubmenu: boolean
  index: number
}

export function enabledDomMenuEntryIndices(entries: RichMarkdownDomMenuEntry[]): number[] {
  const indices: number[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.kind === 'separator') {
      continue
    }
    // Why: submenu triggers carry no disabled flag, so they are always actionable.
    if (entry.kind === 'submenu' || entry.disabled !== true) {
      indices.push(index)
    }
  }
  return indices
}

export function initialDomMenuFocus(
  entries: RichMarkdownDomMenuEntry[]
): RichMarkdownDomMenuFocus | null {
  const [first] = enabledDomMenuEntryIndices(entries)
  return first === undefined ? null : { inSubmenu: false, index: first }
}

export function levelDomMenuEntries(
  model: RichMarkdownDomMenuEntry[],
  openSubmenuIndex: number | null,
  inSubmenu: boolean
): RichMarkdownDomMenuEntry[] {
  if (!inSubmenu || openSubmenuIndex === null) {
    return model
  }
  const open = model[openSubmenuIndex]
  return open?.kind === 'submenu' ? open.items : model
}

export function moveDomMenuFocus(options: {
  model: RichMarkdownDomMenuEntry[]
  openSubmenuIndex: number | null
  focus: RichMarkdownDomMenuFocus | null
  direction: 1 | -1
}): RichMarkdownDomMenuFocus | null {
  const { model, openSubmenuIndex, focus, direction } = options
  // Why: a submenu focus without an open submenu is stale (closing the menu
  // level always resets it), so snap back to the top level instead of walking
  // a level that is no longer rendered.
  const inSubmenu = focus?.inSubmenu === true && model[openSubmenuIndex ?? -1]?.kind === 'submenu'
  const entries = levelDomMenuEntries(model, openSubmenuIndex, inSubmenu)
  const enabled = enabledDomMenuEntryIndices(entries)
  if (enabled.length === 0) {
    return focus
  }
  const current = focus ? enabled.indexOf(focus.index) : -1
  const next = enabled[(current + direction + enabled.length) % enabled.length]
  return { inSubmenu, index: next }
}
