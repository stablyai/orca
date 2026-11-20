// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  buildRichMarkdownDomContextMenuModel,
  enabledDomMenuEntryIndices,
  initialDomMenuFocus,
  levelDomMenuEntries,
  moveDomMenuFocus,
  shouldUseRichMarkdownDomContextMenu,
  type RichMarkdownDomMenuEntry
} from './rich-markdown-dom-context-menu-model'
import { RichMarkdownDomContextMenu } from './rich-markdown-dom-context-menu'
import { createRichMarkdownExtensions } from './rich-markdown/schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown/document/rich-markdown-source-transport'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

afterEach(cleanup)

function textPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, nodePosition) => {
    if (node.isText && node.text === text) {
      position = nodePosition
      return false
    }
    return true
  })
  if (position === null) {
    throw new Error(`Missing text: ${text}`)
  }
  return position
}

function createEditor(content: string): { editor: Editor; element: HTMLDivElement } {
  const element = document.createElement('div')
  document.body.append(element)
  // Why: happy-dom reports zero rects, which would fail the same in-scope
  // coordinate guard the Electron IPC path uses for multi-editor windows.
  const inScopeRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 1000,
    width: 1000,
    height: 1000,
    toJSON: () => ({
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
      top: 0,
      right: 1000,
      bottom: 1000,
      left: 0
    })
  }
  element.getBoundingClientRect = () => inScopeRect
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
  return { editor, element }
}

function topLevelLabels(entries: RichMarkdownDomMenuEntry[]): (string | null)[] {
  return entries.map((entry) =>
    entry.kind === 'separator' ? null : entry.kind === 'submenu' ? entry.label : entry.label
  )
}

describe('rich markdown dom context menu gate', () => {
  it('stays off on plain desktop renderer builds', () => {
    expect(shouldUseRichMarkdownDomContextMenu()).toBe(false)
  })

  it('turns on under the Tauri native host', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: vi.fn() }
    })
    try {
      expect(shouldUseRichMarkdownDomContextMenu()).toBe(true)
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test stages and removes a Tauri host marker that the DOM type omits.
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it('turns on for the paired web client', () => {
    Object.defineProperty(window, '__ORCA_WEB_CLIENT__', {
      configurable: true,
      value: true
    })
    try {
      expect(shouldUseRichMarkdownDomContextMenu()).toBe(true)
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test stages and removes a web-client marker that the DOM type omits.
      delete (window as unknown as Record<string, unknown>).__ORCA_WEB_CLIENT__
    }
  })
})

describe('rich markdown dom context menu model', () => {
  it('mirrors the Electron template order without a table section outside tables', () => {
    expect(
      topLevelLabels(buildRichMarkdownDomContextMenuModel({ cellType: null, hasSelection: true }))
    ).toEqual([
      'Add link',
      null,
      'Format',
      'Paragraph',
      'Insert',
      null,
      'Cut',
      'Copy',
      'Paste',
      'Paste as plain text',
      'Select all'
    ])
  })

  it('adds an enabled table section for body cells', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: 'body', hasSelection: true })
    const table = model.find((entry) => entry.kind === 'submenu' && entry.label === 'Table')
    expect(table?.kind).toBe('submenu')
    if (table?.kind !== 'submenu') {
      return
    }
    expect(table.items.map((item) => (item.kind === 'separator' ? null : item.label))).toEqual([
      'Insert row above',
      'Insert row below',
      'Delete row',
      null,
      'Insert column left',
      'Insert column right',
      'Delete column',
      null,
      'Delete table'
    ])
    expect(table.items.every((item) => item.kind !== 'command' || !item.disabled)).toBe(true)
  })

  it('disables row removal actions for header cells like the native menu', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: 'header', hasSelection: true })
    const table = model.find((entry) => entry.kind === 'submenu' && entry.label === 'Table')
    if (table?.kind !== 'submenu') {
      throw new Error('Missing table submenu')
    }
    const disabledByLabel = new Map<string, boolean | undefined>()
    for (const item of table.items) {
      if (item.kind === 'command') {
        disabledByLabel.set(item.label, item.disabled)
      }
    }
    expect(disabledByLabel.get('Insert row above')).toBe(true)
    expect(disabledByLabel.get('Delete row')).toBe(true)
    expect(disabledByLabel.get('Insert row below')).toBeFalsy()
    expect(disabledByLabel.get('Insert column left')).toBeFalsy()
    expect(disabledByLabel.get('Delete table')).toBeFalsy()
  })

  it('disables cut and copy without a selection', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: null, hasSelection: false })
    const disabledByLabel = new Map<string, boolean | undefined>()
    for (const entry of model) {
      if (entry.kind === 'edit') {
        disabledByLabel.set(entry.label, entry.disabled)
      }
    }
    expect(disabledByLabel.get('Cut')).toBe(true)
    expect(disabledByLabel.get('Copy')).toBe(true)
    expect(disabledByLabel.get('Paste')).toBeFalsy()
  })
})

describe('rich markdown dom context menu keyboard model', () => {
  it('starts on the first enabled entry and skips separators', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: null, hasSelection: true })
    expect(initialDomMenuFocus(model)).toEqual({ inSubmenu: false, index: 0 })
    expect(enabledDomMenuEntryIndices(model)).toEqual([0, 2, 3, 4, 6, 7, 8, 9, 10])
  })

  it('returns null when nothing is actionable', () => {
    expect(initialDomMenuFocus([])).toBeNull()
    expect(initialDomMenuFocus([{ kind: 'separator' }])).toBeNull()
  })

  it('moves within the level with wraparound', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: null, hasSelection: true })
    expect(moveDomMenuFocus({ model, openSubmenuIndex: null, focus: null, direction: 1 })).toEqual({
      inSubmenu: false,
      index: 0
    })
    // Index 1 is the separator after Add link, so moving down skips it.
    expect(
      moveDomMenuFocus({
        model,
        openSubmenuIndex: null,
        focus: { inSubmenu: false, index: 0 },
        direction: 1
      })
    ).toEqual({ inSubmenu: false, index: 2 })
    // Wrapping past the last entry lands back on Add link.
    expect(
      moveDomMenuFocus({
        model,
        openSubmenuIndex: null,
        focus: { inSubmenu: false, index: 10 },
        direction: 1
      })
    ).toEqual({ inSubmenu: false, index: 0 })
    expect(
      moveDomMenuFocus({
        model,
        openSubmenuIndex: null,
        focus: { inSubmenu: false, index: 0 },
        direction: -1
      })
    ).toEqual({ inSubmenu: false, index: 10 })
  })

  it('navigates submenu items only while a submenu is open', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: 'body', hasSelection: true })
    const tableIndex = model.findIndex(
      (entry) =>
        entry.kind === 'submenu' &&
        entry.items.some((item) => item.kind === 'command' && item.command === 'delete-table')
    )
    expect(tableIndex).toBeGreaterThan(-1)
    // Closed: movement stays on the top level even with a submenu focus.
    expect(
      moveDomMenuFocus({
        model,
        openSubmenuIndex: null,
        focus: { inSubmenu: true, index: 0 },
        direction: 1
      })?.inSubmenu
    ).toBe(false)
    // Open: movement walks the table entries and wraps inside them.
    expect(levelDomMenuEntries(model, tableIndex, true).length).toBe(9)
    expect(
      moveDomMenuFocus({
        model,
        openSubmenuIndex: tableIndex,
        focus: { inSubmenu: true, index: 0 },
        direction: 1
      })
    ).toEqual({ inSubmenu: true, index: 1 })
    expect(
      moveDomMenuFocus({
        model,
        openSubmenuIndex: tableIndex,
        focus: { inSubmenu: true, index: 8 },
        direction: 1
      })
    ).toEqual({ inSubmenu: true, index: 0 })
  })

  it('skips disabled entries without stranding focus', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: 'header', hasSelection: true })
    const headerTableIndex = model.findIndex(
      (entry) =>
        entry.kind === 'submenu' &&
        entry.items.some((item) => item.kind === 'command' && item.command === 'delete-table')
    )
    expect(headerTableIndex).toBeGreaterThan(-1)
    // Insert row above (index 0) is disabled in header rows, so the submenu opens on row below.
    expect(initialDomMenuFocus(levelDomMenuEntries(model, headerTableIndex, true))).toEqual({
      inSubmenu: false,
      index: 1
    })
  })
})

describe('rich markdown dom context menu component', () => {
  it('runs bold against the right-clicked selection', () => {
    const { editor, element } = createEditor('hello world')
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      const from = textPosition(editor, 'hello world')
      editor.commands.setTextSelection({ from, to: from + 'hello world'.length })
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ inside: -1, pos: from + 1 })
      fireEvent.contextMenu(editor.view.dom, { clientX: 50, clientY: 60 })
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).not.toBeNull()
      fireEvent.mouseEnter(document.body.querySelector('[data-submenu="Format"]')!)
      fireEvent.click(document.body.querySelector('[data-command="bold"]')!)
      expect(editor.getHTML()).toContain('<strong>')
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).toBeNull()
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('routes table commands from the table submenu', () => {
    const { editor, element } = createEditor(TABLE)
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
        inside: -1,
        pos: textPosition(editor, 'b2')
      })
      const targetCell = element.querySelectorAll('td').item(3)
      fireEvent.contextMenu(targetCell, { clientX: 12, clientY: 34 })
      fireEvent.mouseEnter(document.body.querySelector('[data-submenu="Table"]')!)
      fireEvent.click(document.body.querySelector('[data-command="delete-row"]')!)
      expect(editor.state.doc.textContent).toContain('a1')
      expect(editor.state.doc.textContent).not.toContain('a2')
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('marks header row actions disabled in the rendered table submenu', () => {
    const { editor, element } = createEditor(TABLE)
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      fireEvent.contextMenu(element.querySelector('th')!, { clientX: 8, clientY: 9 })
      fireEvent.mouseEnter(document.body.querySelector('[data-submenu="Table"]')!)
      expect(
        document.body
          .querySelector('[data-command="insert-row-above"]')
          ?.getAttribute('data-disabled')
      ).toBe('true')
      expect(
        document.body.querySelector('[data-command="delete-table"]')?.getAttribute('data-disabled')
      ).toBeNull()
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('closes on escape without running a command', () => {
    const { editor, element } = createEditor('hello world')
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      fireEvent.contextMenu(editor.view.dom, { clientX: 50, clientY: 60 })
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).not.toBeNull()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).toBeNull()
      expect(editor.getHTML()).not.toContain('<strong>')
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('focuses the first entry on open and walks with arrows', () => {
    const { editor, element } = createEditor('hello world')
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      fireEvent.contextMenu(editor.view.dom, { clientX: 50, clientY: 60 })
      const focusedLabel = (): string | null => {
        const focused = document.body.querySelector(
          '[data-testid="rich-markdown-dom-context-menu"] [data-focused="true"]'
        )
        return focused?.textContent ?? null
      }
      expect(focusedLabel()).toBe('Add link')
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      expect(focusedLabel()).toBe('Format')
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      expect(focusedLabel()).toBe('Paragraph')
      fireEvent.keyDown(window, { key: 'ArrowUp' })
      expect(focusedLabel()).toBe('Format')
      fireEvent.keyDown(window, { key: 'End' })
      expect(focusedLabel()).toBe('Select all')
      fireEvent.keyDown(window, { key: 'Home' })
      expect(focusedLabel()).toBe('Add link')
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('opens submenus with enter and runs commands from the keyboard', () => {
    const { editor, element } = createEditor('hello world')
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      const from = textPosition(editor, 'hello world')
      editor.commands.setTextSelection({ from, to: from + 'hello world'.length })
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ inside: -1, pos: from + 1 })
      fireEvent.contextMenu(editor.view.dom, { clientX: 50, clientY: 60 })
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      expect(
        document.body.querySelector('[data-submenu="Format"]')?.getAttribute('data-focused')
      ).toBe('true')
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(
        document.body.querySelector('[data-command="bold"]')?.getAttribute('data-focused')
      ).toBe('true')
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      expect(
        document.body.querySelector('[data-command="italic"]')?.getAttribute('data-focused')
      ).toBe('true')
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(editor.getHTML()).toContain('<em>')
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).toBeNull()
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('closes the submenu before the menu on repeated escape', () => {
    const { editor, element } = createEditor(TABLE)
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      fireEvent.contextMenu(element.querySelector('td')!, { clientX: 12, clientY: 34 })
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      expect(
        document.body.querySelector('[data-submenu="Table"]')?.getAttribute('data-focused')
      ).toBe('true')
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      expect(document.body.querySelector('[data-command="delete-row"]')).not.toBeNull()
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
      expect(document.body.querySelector('[data-command="delete-row"]')).toBeNull()
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).not.toBeNull()
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      expect(document.body.querySelector('[data-command="delete-row"]')).not.toBeNull()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(document.body.querySelector('[data-command="delete-row"]')).toBeNull()
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).not.toBeNull()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).toBeNull()
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })
})
