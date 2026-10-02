// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSystemPrefersDarkSubscriptionForTests } from '@/components/terminal-pane/use-system-prefers-dark'

const editorProps: { current: Record<string, unknown> | null } = vi.hoisted(() => ({
  current: null
}))
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
      openFiles: [],
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
})
