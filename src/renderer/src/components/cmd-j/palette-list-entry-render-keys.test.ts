import { describe, expect, it } from 'vitest'
import { buildPaletteListEntryRenderKeys } from './palette-list-entry-render-keys'

describe('buildPaletteListEntryRenderKeys', () => {
  it('leaves unique ids untouched', () => {
    const ids = ['__header_open_tabs__', 'workspace-tab:a', 'worktree:b']
    expect(buildPaletteListEntryRenderKeys(ids)).toEqual(ids)
  })

  it('disambiguates a repeated persisted id', () => {
    expect(
      buildPaletteListEntryRenderKeys([
        'workspace-tab:editor:lungfish',
        'workspace-tab:editor:lungfish',
        'workspace-tab:editor:lungfish'
      ])
    ).toEqual([
      'workspace-tab:editor:lungfish',
      'palette-dup:1:workspace-tab:editor:lungfish',
      'palette-dup:2:workspace-tab:editor:lungfish'
    ])
  })

  it('never emits a key twice', () => {
    const keys = buildPaletteListEntryRenderKeys(['a', 'a', 'b', 'a', 'b', 'palette-dup:1:a'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps keys stable as later entries drop away', () => {
    const full = buildPaletteListEntryRenderKeys(['header', 'tab:x', 'tab:x', 'tab:y'])
    const narrowed = buildPaletteListEntryRenderKeys(['header', 'tab:x', 'tab:x'])
    expect(narrowed).toEqual(full.slice(0, 3))
  })

  // Generated keys must not collide with persisted sibling IDs or React can transfer the duplicate’s frozen state.
  it('never mints a key a sibling entry already owns as its persisted id', () => {
    const full = buildPaletteListEntryRenderKeys(['a', 'a', 'palette-dup:1:a'])
    const narrowed = buildPaletteListEntryRenderKeys(['a', 'palette-dup:1:a'])
    expect(new Set(full).size).toBe(full.length)
    // The distinct entry keeps its own key across the narrow; the duplicate's key is not reused.
    expect(full[2]).not.toBe(full[1])
    expect(narrowed[1]).toBe(full[2])
    expect(narrowed).not.toContain(full[1])
  })
})
