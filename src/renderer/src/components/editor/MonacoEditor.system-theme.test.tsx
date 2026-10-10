// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import type * as MonacoModule from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSystemPrefersDarkSubscriptionForTests } from '@/components/terminal-pane/use-system-prefers-dark'
import { setOmarchyThemePalette } from '@/lib/omarchy-theme-state'
import {
  deriveOmarchyPalette,
  OMARCHY_SEED_COLOR_KEYS,
  type OmarchyThemeSeed
} from '../../../../shared/omarchy-theme-palette'

const editorProps: { current: Record<string, unknown> | null } = vi.hoisted(() => ({
  current: null
}))
const definedThemes: { current: Map<string, { base: string; colors: Record<string, string> }> } =
  vi.hoisted(() => ({ current: new Map() }))
const settingsState: { theme: 'system' | 'dark' | 'light' } = vi.hoisted(() => ({
  theme: 'system'
}))

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('monaco-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof MonacoModule>()
  return {
    ...actual,
    editor: {
      ...actual.editor,
      defineTheme: (name: string, data: { base: string; colors: Record<string, string> }) => {
        definedThemes.current.set(name, data)
      }
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: {
        get theme() {
          return settingsState.theme
        },
        terminalFontSize: 13,
        terminalFontFamily: 'monospace'
      },
      editorFontZoomLevel: 0,
      setPendingEditorReveal: vi.fn(),
      setEditorCursorLine: vi.fn(),
      addDiffComment: vi.fn(),
      deleteDiffComment: vi.fn(),
      updateDiffComment: vi.fn(),
      scrollToDiffCommentId: null,
      setScrollToDiffCommentId: vi.fn(),
      worktreeDiffComments: {}
    })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))

import MonacoEditor from './MonacoEditor'

function installMatchMedia(initialMatches: boolean): {
  emit: (matches: boolean) => void
} {
  let matches = initialMatches
  const listeners = new Set<EventListener>()
  const mediaQuery = '(prefers-color-scheme: dark)'
  const media: MediaQueryList = {
    get matches() {
      return matches
    },
    media: mediaQuery,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener(type, listener) {
      if (type === 'change' && typeof listener === 'function') {
        listeners.add(listener)
      }
    },
    removeEventListener(type, listener) {
      if (type === 'change' && typeof listener === 'function') {
        listeners.delete(listener)
      }
    },
    dispatchEvent() {
      return false
    }
  }
  window.matchMedia = () => media
  return {
    emit(nextMatches: boolean): void {
      matches = nextMatches
      const event = new MediaQueryListEvent('change', { matches: nextMatches, media: mediaQuery })
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
}

function renderEditor(): void {
  render(
    <MonacoEditor
      fileId="file"
      filePath="/repo/hello.ts"
      viewStateKey="pane:hello"
      relativePath="hello.ts"
      content={'function hello() {}\n'}
      language="typescript"
      onContentChange={vi.fn()}
      onSave={vi.fn()}
    />
  )
}

const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  editorProps.current = null
  settingsState.theme = 'system'
  setOmarchyThemePalette(null)
  definedThemes.current.clear()
  resetSystemPrefersDarkSubscriptionForTests()
  window.matchMedia = originalMatchMedia
})

describe('MonacoEditor system theme', () => {
  it('follows a system color-scheme change while the editor stays mounted', () => {
    const media = installMatchMedia(false)
    renderEditor()

    expect(editorProps.current?.theme).toBe('vs')

    act(() => {
      media.emit(true)
    })
    expect(editorProps.current?.theme).toBe('vs-dark')

    act(() => {
      media.emit(false)
    })
    expect(editorProps.current?.theme).toBe('vs')
  })

  it('keeps an explicit theme when the system color scheme changes', () => {
    settingsState.theme = 'light'
    const media = installMatchMedia(true)
    renderEditor()

    expect(editorProps.current?.theme).toBe('vs')

    act(() => {
      media.emit(false)
    })
    expect(editorProps.current?.theme).toBe('vs')
  })

  it('uses the live Omarchy palette and repaints when it changes', () => {
    settingsState.theme = 'dark'
    installMatchMedia(true)
    renderEditor()
    expect(editorProps.current?.theme).toBe('vs-dark')

    act(() => {
      setOmarchyThemePalette(deriveOmarchyPalette(omarchySeed('dark', '#0a1220')))
    })
    expect(editorProps.current?.theme).toBe('orca-omarchy')
    expect(definedThemes.current.get('orca-omarchy')?.base).toBe('vs-dark')
    expect(definedThemes.current.get('orca-omarchy')?.colors['editor.background']).toBe('#0a1220')

    act(() => {
      setOmarchyThemePalette(deriveOmarchyPalette(omarchySeed('light', '#f4f4f0')))
    })
    expect(definedThemes.current.get('orca-omarchy')?.base).toBe('vs')
    expect(definedThemes.current.get('orca-omarchy')?.colors['editor.background']).toBe('#f4f4f0')

    act(() => {
      setOmarchyThemePalette(null)
    })
    expect(editorProps.current?.theme).toBe('vs-dark')
  })
})

function omarchySeed(mode: 'dark' | 'light', background: string): OmarchyThemeSeed {
  const seed: Record<string, string> = { mode }
  for (const key of OMARCHY_SEED_COLOR_KEYS) {
    seed[key] = '#808080'
  }
  seed.background = background
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every seed key is assigned above.
  return seed as OmarchyThemeSeed
}
