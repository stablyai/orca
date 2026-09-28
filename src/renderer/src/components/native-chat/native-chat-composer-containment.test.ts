import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const composerField = fs.readFileSync(
  new URL('./NativeChatComposerField.tsx', import.meta.url),
  'utf8'
)
const autocompleteMenus = fs.readFileSync(
  new URL('./NativeChatAutocompleteMenus.tsx', import.meta.url),
  'utf8'
)

describe('native chat composer paint containment (#10481)', () => {
  it('bounds caret repaints to the composer input shell', () => {
    expect(composerField).toContain('[contain:paint]')
  })

  it('keeps the outer composer uncontained so the pickers can overflow it', () => {
    // The pickers are siblings that render above the shell via `bottom-full`;
    // containing their parent would clip them.
    const outerShell = composerField.slice(0, composerField.indexOf('[contain:paint]'))
    expect(outerShell).toContain('<div className="shrink-0 bg-background">')
    expect(outerShell).not.toContain('contain:paint')
  })

  it('lifts both pickers above the contained shell', () => {
    // The shell is a stacking context now, so it paints at z-index 0 in tree
    // order — an unlayered picker would lose its drop shadow to it.
    for (const picker of ['bottom-full left-0 right-0 z-20', 'bottom-full left-3 right-3 z-20']) {
      expect(autocompleteMenus).toContain(picker)
    }
  })
})
