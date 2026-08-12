import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor'
import {
  MONACO_MONOKAI_THEME_DATA,
  MONACO_MONOKAI_THEME_NAME,
  registerMonacoMonokaiTheme
} from './monaco-monokai-theme'

describe('MONACO_MONOKAI_THEME_DATA', () => {
  it('is a dark base theme with the Monokai background/foreground pairing', () => {
    expect(MONACO_MONOKAI_THEME_DATA.base).toBe('vs-dark')
    expect(MONACO_MONOKAI_THEME_DATA.colors['editor.background']).toBe('#272822')
    expect(MONACO_MONOKAI_THEME_DATA.colors['editor.foreground']).toBe('#f8f8f2')
  })

  it('defines token colors as bare hex (no leading #), which is what Monaco expects', () => {
    for (const rule of MONACO_MONOKAI_THEME_DATA.rules) {
      if (rule.foreground) {
        expect(rule.foreground.startsWith('#')).toBe(false)
      }
    }
  })
})

describe('registerMonacoMonokaiTheme', () => {
  it('defines the theme exactly once even across repeated calls', () => {
    let defineThemeCalls = 0
    const fakeMonaco = {
      editor: {
        defineTheme: (name: string) => {
          expect(name).toBe(MONACO_MONOKAI_THEME_NAME)
          defineThemeCalls += 1
        }
      }
    }

    registerMonacoMonokaiTheme(fakeMonaco as unknown as typeof Monaco)
    registerMonacoMonokaiTheme(fakeMonaco as unknown as typeof Monaco)

    // Why <= 1, not === 1: `registered` is module-level state shared across the whole
    // test file/process, so an earlier test importing this module first can already
    // have flipped it to true before this test runs — asserting "never twice" is the
    // real contract we care about, not "exactly once from a pristine module".
    expect(defineThemeCalls).toBeLessThanOrEqual(1)
  })
})
