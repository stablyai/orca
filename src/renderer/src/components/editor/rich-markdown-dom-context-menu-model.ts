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
  t?: (key: string, defaultValue: string) => string
}): RichMarkdownDomMenuEntry[] {
  const { cellType, hasSelection, t = translate } = options
  const inHeaderRow = cellType === 'header'
  // Why: one t() call per label keeps every key a static literal for catalog
  // extraction while keeping this file under the max-lines budget.
  const labels = {
    addLink: t('auto.components.editor.RichMarkdownDomContextMenu.addLink', 'Add link'),
    format: t('auto.components.editor.RichMarkdownDomContextMenu.format', 'Format'),
    bold: t('auto.components.editor.RichMarkdownDomContextMenu.bold', 'Bold'),
    italic: t('auto.components.editor.RichMarkdownDomContextMenu.italic', 'Italic'),
    strike: t('auto.components.editor.RichMarkdownDomContextMenu.strike', 'Strike'),
    inlineCode: t('auto.components.editor.RichMarkdownDomContextMenu.inlineCode', 'Inline code'),
    codeBlock: t('auto.components.editor.RichMarkdownDomContextMenu.codeBlock', 'Code block'),
    quote: t('auto.components.editor.RichMarkdownDomContextMenu.quote', 'Quote'),
    paragraph: t('auto.components.editor.RichMarkdownDomContextMenu.paragraph', 'Paragraph'),
    bodyText: t('auto.components.editor.RichMarkdownDomContextMenu.bodyText', 'Body text'),
    heading1: t('auto.components.editor.RichMarkdownDomContextMenu.heading1', 'Heading 1'),
    heading2: t('auto.components.editor.RichMarkdownDomContextMenu.heading2', 'Heading 2'),
    heading3: t('auto.components.editor.RichMarkdownDomContextMenu.heading3', 'Heading 3'),
    heading4: t('auto.components.editor.RichMarkdownDomContextMenu.heading4', 'Heading 4'),
    heading5: t('auto.components.editor.RichMarkdownDomContextMenu.heading5', 'Heading 5'),
    bulletList: t('auto.components.editor.RichMarkdownDomContextMenu.bulletList', 'Bullet list'),
    numberedList: t(
      'auto.components.editor.RichMarkdownDomContextMenu.numberedList',
      'Numbered list'
    ),
    checklist: t('auto.components.editor.RichMarkdownDomContextMenu.checklist', 'Checklist'),
    insert: t('auto.components.editor.RichMarkdownDomContextMenu.insert', 'Insert'),
    link: t('auto.components.editor.RichMarkdownDomContextMenu.link', 'Link'),
    image: t('auto.components.editor.RichMarkdownDomContextMenu.image', 'Image'),
    divider: t('auto.components.editor.RichMarkdownDomContextMenu.divider', 'Divider'),
    cut: t('auto.components.editor.RichMarkdownDomContextMenu.cut', 'Cut'),
    copy: t('auto.components.editor.RichMarkdownDomContextMenu.copy', 'Copy'),
    paste: t('auto.components.editor.RichMarkdownDomContextMenu.paste', 'Paste'),
    pasteAsPlainText: t(
      'auto.components.editor.RichMarkdownDomContextMenu.pasteAsPlainText',
      'Paste as plain text'
    ),
    selectAll: t('auto.components.editor.RichMarkdownDomContextMenu.selectAll', 'Select all')
  }
  return [
    { kind: 'command', command: 'add-link', label: labels.addLink },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: labels.format,
      items: [
        { kind: 'command', command: 'bold', label: labels.bold },
        { kind: 'command', command: 'italic', label: labels.italic },
        { kind: 'command', command: 'strike', label: labels.strike },
        { kind: 'command', command: 'inline-code', label: labels.inlineCode },
        { kind: 'command', command: 'code-block', label: labels.codeBlock },
        { kind: 'command', command: 'blockquote', label: labels.quote }
      ]
    },
    {
      kind: 'submenu',
      label: labels.paragraph,
      items: [
        { kind: 'command', command: 'paragraph', label: labels.bodyText },
        { kind: 'command', command: 'heading-1', label: labels.heading1 },
        { kind: 'command', command: 'heading-2', label: labels.heading2 },
        { kind: 'command', command: 'heading-3', label: labels.heading3 },
        { kind: 'command', command: 'heading-4', label: labels.heading4 },
        { kind: 'command', command: 'heading-5', label: labels.heading5 },
        { kind: 'separator' },
        { kind: 'command', command: 'bullet-list', label: labels.bulletList },
        { kind: 'command', command: 'ordered-list', label: labels.numberedList },
        { kind: 'command', command: 'task-list', label: labels.checklist }
      ]
    },
    {
      kind: 'submenu',
      label: labels.insert,
      items: [
        { kind: 'command', command: 'add-link', label: labels.link },
        { kind: 'command', command: 'image', label: labels.image },
        { kind: 'command', command: 'divider', label: labels.divider },
        { kind: 'command', command: 'code-block', label: labels.codeBlock }
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
    { kind: 'edit', action: 'cut', label: labels.cut, disabled: !hasSelection },
    { kind: 'edit', action: 'copy', label: labels.copy, disabled: !hasSelection },
    { kind: 'edit', action: 'paste', label: labels.paste },
    { kind: 'edit', action: 'paste-plain', label: labels.pasteAsPlainText },
    { kind: 'edit', action: 'select-all', label: labels.selectAll }
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
