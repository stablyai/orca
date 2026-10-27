import { describe, expect, it } from 'vitest'
import { buildPaletteListEntryRenderKeys } from './palette-list-entry-render-keys'

describe('buildPaletteListEntryRenderKeys', () => {
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
