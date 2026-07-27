/**
 * Guards the two tab-context-menu invariants: every action item carries an
 * icon, and no item can wrap onto a second line on any platform.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TAB_CONTEXT_MENU_CONTENT_CLASS,
  TAB_CONTEXT_SUBMENU_CONTENT_CLASS
} from './tab-context-menu-sizing'

const TAB_MENU_SOURCES = [
  'EditorFileTabContextMenu.tsx',
  'SortableTabContextMenu.tsx',
  'BrowserTab.tsx',
  'TabWorkspaceLayoutMenuSection.tsx',
  'TerminalTabSplitMenuSection.tsx'
] as const

function readSource(fileName: string): string {
  return readFileSync(join(__dirname, fileName), 'utf8')
}

/** Item bodies, minus the color swatches which are deliberately icon-free. */
function actionItemBodies(source: string): string[] {
  const bodies: string[] = []
  const opening = /<DropdownMenu(?:Item|SubTrigger)\b/g
  let match: RegExpExecArray | null
  while ((match = opening.exec(source)) !== null) {
    const closing = source.indexOf('</DropdownMenu', match.index + 1)
    const body = source.slice(match.index, closing === -1 ? source.length : closing)
    if (body.includes('rounded-full')) {
      continue
    }
    bodies.push(body)
  }
  return bodies
}

describe('tab context menu consistency', () => {
  it.each(TAB_MENU_SOURCES)('gives every action item an icon in %s', (fileName) => {
    const bodies = actionItemBodies(readSource(fileName))
    expect(bodies.length).toBeGreaterThan(0)

    for (const body of bodies) {
      // Icons render as a self-closing lucide element or an icon-returning helper.
      const hasIcon = /<[A-Z][A-Za-z0-9]*\s+className="size-3\.5/.test(body) || /Icon\(/.test(body)
      expect(hasIcon, `menu item without an icon in ${fileName}:\n${body}`).toBe(true)
    }
  })

  it.each(TAB_MENU_SOURCES)('sizes menu surfaces from the shared rule in %s', (fileName) => {
    const source = readSource(fileName)
    if (!source.includes('DropdownMenuContent') && !source.includes('DropdownMenuSubContent')) {
      return
    }
    expect(source).toContain('tab-context-menu-sizing')
    // Why: a fixed `w-*` reintroduces wrapping once a label or shortcut grows.
    expect(source).not.toMatch(/className="w-\d+"/)
  })

  it('keeps labels on one line and bounded by the viewport', () => {
    for (const rule of [TAB_CONTEXT_MENU_CONTENT_CLASS, TAB_CONTEXT_SUBMENU_CONTENT_CLASS]) {
      expect(rule).toContain('whitespace-nowrap')
      expect(rule).toContain('max-w-[calc(100vw-1rem)]')
    }
  })
})
