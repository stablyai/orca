// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  current: {
    theme: 'dark',
    terminalFontSize: 13,
    editorColorTheme: 'auto' as string | undefined
  } as Record<string, unknown>
}))

const monacoMock = vi.hoisted(() => ({
  colorizeCalls: 0,
  setThemeCalls: [] as string[]
}))

vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: {
      setTheme: (name: string) => {
        monacoMock.setThemeCalls.push(name)
      },
      colorize: () => {
        monacoMock.colorizeCalls += 1
        return Promise.resolve('<span>colorized</span>')
      }
    },
    languages: {
      getLanguages: () => [],
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: storeState.current, editorFontZoomLevel: 0 })
}))

import MonacoCodeExcerpt from './MonacoCodeExcerpt'

afterEach(() => {
  cleanup()
  monacoMock.colorizeCalls = 0
  monacoMock.setThemeCalls = []
})

describe('MonacoCodeExcerpt', () => {
  it('re-colorizes when the resolved editor color theme changes, even though code/language stay the same', async () => {
    storeState.current = { theme: 'dark', terminalFontSize: 13, editorColorTheme: 'auto' }
    // Why a stable reference: a new array literal on every render would retrigger
    // the colorize effect via the `lines` dependency regardless of the theme fix,
    // masking the exact regression this test exists to catch.
    const stableLines = ['const x = 1']

    const { rerender } = render(
      <MonacoCodeExcerpt
        lines={stableLines}
        firstLineNumber={1}
        highlightedStartLine={0}
        highlightedEndLine={0}
        language="typescript"
      />
    )

    // Why flush a microtask tick: the colorize effect awaits a promise chain
    // (ensureColorizationLanguage().then(colorize).then(setHtmlLines)) before
    // the first call lands.
    await act(async () => {
      await Promise.resolve()
    })
    const callsAfterMount = monacoMock.colorizeCalls
    expect(callsAfterMount).toBeGreaterThan(0)

    // Why this is the regression case: switching the theme (Settings >
    // Appearance > Code Editor) must re-run colorize(), or an already-mounted
    // excerpt keeps showing token colors baked in under the previous theme —
    // colorize() bakes theme-specific mtk* classes into HTML at call time and
    // does not react to a later monaco.editor.setTheme() call on its own.
    storeState.current = { theme: 'dark', terminalFontSize: 13, editorColorTheme: 'monokai' }
    rerender(
      <MonacoCodeExcerpt
        lines={stableLines}
        firstLineNumber={1}
        highlightedStartLine={0}
        highlightedEndLine={0}
        language="typescript"
      />
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(monacoMock.colorizeCalls).toBeGreaterThan(callsAfterMount)
  })
})
