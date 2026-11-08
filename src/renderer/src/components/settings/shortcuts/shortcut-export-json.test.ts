import { describe, expect, it } from 'vitest'
import { buildShortcutExportJson } from './shortcut-export-json'
import { groupDefinitions } from './shortcut-groups'

type Parsed = { platform: string; shortcuts: { id: string; bindings: string[]; display: string }[] }

describe('buildShortcutExportJson', () => {
  const groups = groupDefinitions([])

  it('lists every registry shortcut with platform defaults', () => {
    const parsed: Parsed = JSON.parse(
      buildShortcutExportJson({ groups, keybindings: {}, platform: 'darwin' })
    )
    expect(parsed.platform).toBe('darwin')
    expect(parsed.shortcuts).toHaveLength(groups.flatMap((g) => g.items).length)
    expect(parsed.shortcuts.some((s) => s.bindings.length > 0 && s.display.includes('⌘'))).toBe(
      true
    )
  })

  it('applies user overrides and disabled actions', () => {
    const id = groups[0].items[0].id
    const other = groups[0].items[1].id
    const parsed: Parsed = JSON.parse(
      buildShortcutExportJson({
        groups,
        keybindings: { [id]: ['Ctrl+Alt+J'], [other]: [] },
        platform: 'linux'
      })
    )
    expect(parsed.shortcuts.find((s) => s.id === id)?.bindings).toEqual(['Ctrl+Alt+J'])
    expect(parsed.shortcuts.find((s) => s.id === other)?.bindings).toEqual([])
  })
})
