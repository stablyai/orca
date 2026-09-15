import { describe, expect, it } from 'vitest'

import { buildEditorTextDirectionClass } from './editor-text-direction-class'

describe('buildEditorTextDirectionClass', () => {
  it('emits no class for ltr so unaffected editors keep a clean container', () => {
    expect(buildEditorTextDirectionClass('ltr')).toBe('')
  })

  it('maps auto and rtl to their scoped classes', () => {
    expect(buildEditorTextDirectionClass('auto')).toBe('editor-dir-auto')
    expect(buildEditorTextDirectionClass('rtl')).toBe('editor-dir-rtl')
  })
})
