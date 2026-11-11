// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const installFindShortcut = vi.hoisted(() => vi.fn(() => vi.fn()))
const syncContentOnMount = vi.hoisted(() => vi.fn(() => false))
const syncContentUpdate = vi.hoisted(() => vi.fn())

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return <div data-testid="monaco-editor-stub" />
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/lib/editor/monaco/monaco-setup', () => ({ monaco: {} }))
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', terminalFontSize: 13, terminalFontFamily: 'monospace' },
      editorFontZoomLevel: 0
    })
}))
vi.mock('@/components/editor/editor-shortcuts', () => ({
  installMonacoEditorCommandPaletteShortcut: () => vi.fn(),
  installMonacoEditorFindShortcut: installFindShortcut
}))
vi.mock('@/components/editor/monaco-content-sync', () => ({
  syncContentOnMount,
  syncContentUpdate
}))

import { AutomationEditorPromptEditor } from './AutomationEditorPromptEditor'

afterEach(() => {
  cleanup()
  editorProps.current = null
  installFindShortcut.mockClear()
  syncContentOnMount.mockClear()
  syncContentUpdate.mockClear()
})

describe('AutomationEditorPromptEditor', () => {
  it('dismisses on Escape only when find is closed', () => {
    const onDismiss = vi.fn()
    const editorDom = document.createElement('div')
    const editorInstance = {
      getContainerDomNode: () => editorDom,
      onDidDispose: vi.fn()
    }
    render(
      <AutomationEditorPromptEditor
        value="prompt"
        placeholder="Prompt placeholder"
        ariaLabel="Prompt"
        onChange={vi.fn()}
        onDismiss={onDismiss}
      />
    )
    const onMount = editorProps.current?.onMount as (editor: typeof editorInstance) => void
    onMount(editorInstance)

    const findWidget = document.createElement('div')
    findWidget.className = 'find-widget'
    editorDom.append(findWidget)
    editorDom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onDismiss).not.toHaveBeenCalled()

    findWidget.setAttribute('aria-hidden', 'true')
    editorDom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
