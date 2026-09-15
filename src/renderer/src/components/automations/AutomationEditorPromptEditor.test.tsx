// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const installFindShortcut = vi.hoisted(() => vi.fn(() => vi.fn()))
const cleanupCommandPaletteShortcut = vi.hoisted(() => vi.fn())
const installCommandPaletteShortcut = vi.hoisted(() => vi.fn(() => cleanupCommandPaletteShortcut))
const syncContentOnMount = vi.hoisted(() => vi.fn(() => false))
const syncContentUpdate = vi.hoisted(() => vi.fn())

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return <div data-testid="monaco-editor-stub" />
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', terminalFontSize: 13, terminalFontFamily: 'monospace' },
      editorFontZoomLevel: 0
    })
}))
vi.mock('@/components/editor/editor-shortcuts', () => ({
  installMonacoEditorCommandPaletteShortcut: installCommandPaletteShortcut,
  installMonacoEditorFindShortcut: installFindShortcut
}))
vi.mock('@/components/editor/monaco-content-sync', () => ({
  syncContentOnMount,
  syncContentUpdate
}))

import { closeUnfocusedMonacoFindOrPreventDialogDismiss } from '@/components/editor/monaco-find-widget'
import {
  AUTOMATION_PROMPT_EDITOR_SLOT,
  AutomationEditorPromptEditor,
  getAutomationPromptEditorRoot
} from './AutomationEditorPromptEditor'

afterEach(() => {
  cleanup()
  editorProps.current = null
  installFindShortcut.mockClear()
  installCommandPaletteShortcut.mockClear()
  cleanupCommandPaletteShortcut.mockClear()
  syncContentOnMount.mockClear()
  syncContentUpdate.mockClear()
})

describe('AutomationEditorPromptEditor', () => {
  it('owns content through defaultValue so Monaco keeps undo history', () => {
    render(
      <AutomationEditorPromptEditor
        value="weekly audit"
        placeholder="Prompt placeholder"
        ariaLabel="Prompt"
        onChange={vi.fn()}
      />
    )

    expect(editorProps.current?.defaultValue).toBe('weekly audit')
    expect(editorProps.current).not.toHaveProperty('value')
    expect(editorProps.current?.defaultLanguage).toBe('plaintext')
    expect(
      (editorProps.current?.options as { placeholder?: string } | undefined)?.placeholder
    ).toBe('Prompt placeholder')
  })

  it('installs editor shortcuts and syncs an external rewrite after mount', () => {
    const editorInstance = {
      getContainerDomNode: () => document.createElement('div'),
      onDidDispose: vi.fn()
    }
    const { rerender } = render(
      <AutomationEditorPromptEditor
        value="original"
        placeholder="Prompt placeholder"
        ariaLabel="Prompt"
        onChange={vi.fn()}
      />
    )

    const onMount = editorProps.current?.onMount as (editor: typeof editorInstance) => void
    onMount(editorInstance)

    expect(installFindShortcut).toHaveBeenCalledWith(editorInstance)
    expect(installCommandPaletteShortcut).toHaveBeenCalledWith(editorInstance)
    expect(syncContentOnMount).toHaveBeenCalledWith(editorInstance, 'original')

    rerender(
      <AutomationEditorPromptEditor
        value="from template"
        placeholder="Prompt placeholder"
        ariaLabel="Prompt"
        onChange={vi.fn()}
      />
    )

    expect(syncContentUpdate).toHaveBeenCalledWith(editorInstance, 'from template')

    const disposeEditor = editorInstance.onDidDispose.mock.calls[0]?.[0] as () => void
    disposeEditor()
    expect(cleanupCommandPaletteShortcut).toHaveBeenCalledTimes(1)
  })

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

  it('does not render a custom placeholder overlay on an empty prompt', () => {
    const { container } = render(
      <AutomationEditorPromptEditor
        value=""
        placeholder="Prompt placeholder"
        ariaLabel="Prompt"
        onChange={vi.fn()}
      />
    )

    expect(container.textContent).not.toContain('Prompt placeholder')
    expect(
      (editorProps.current?.options as { placeholder?: string } | undefined)?.placeholder
    ).toBe('Prompt placeholder')
  })

  it('scopes find-widget lookups to the prompt editor slot, not the document', () => {
    const dialog = document.createElement('div')
    const editorRoot = document.createElement('div')
    editorRoot.setAttribute('data-slot', AUTOMATION_PROMPT_EDITOR_SLOT)
    const nameField = document.createElement('input')
    const background = document.createElement('div')
    const backgroundFind = document.createElement('div')
    backgroundFind.className = 'find-widget'
    const closeButton = document.createElement('button')
    closeButton.className = 'button codicon-widget-close'
    const onBackgroundClose = vi.fn()
    closeButton.addEventListener('click', onBackgroundClose)
    backgroundFind.append(closeButton)
    background.append(backgroundFind)
    dialog.append(editorRoot, nameField)
    document.body.append(dialog, background)

    expect(getAutomationPromptEditorRoot(dialog)).toBe(editorRoot)
    // Why: Radix's Escape listener fires on document, so currentTarget is
    // never the dialog — probing document would see background editors.
    expect(getAutomationPromptEditorRoot(document)).toBeNull()
    expect(getAutomationPromptEditorRoot(null)).toBeNull()
    expect(
      closeUnfocusedMonacoFindOrPreventDialogDismiss({
        root: getAutomationPromptEditorRoot(dialog),
        eventTarget: nameField
      })
    ).toBe(false)
    expect(onBackgroundClose).not.toHaveBeenCalled()

    dialog.remove()
    background.remove()
  })

  it('forwards typed edits to the draft', () => {
    const onChange = vi.fn()
    render(
      <AutomationEditorPromptEditor
        value=""
        placeholder="Prompt placeholder"
        ariaLabel="Prompt"
        onChange={onChange}
      />
    )

    const handleChange = editorProps.current?.onChange as (value: string) => void
    handleChange('typed prompt')
    expect(onChange).toHaveBeenCalledWith('typed prompt')
  })
})
