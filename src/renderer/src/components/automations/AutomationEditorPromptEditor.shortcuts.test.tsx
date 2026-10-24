// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { AutomationEditorPromptEditor } from './AutomationEditorPromptEditor'

const shortcutState = vi.hoisted(
  (): { keybindings: KeybindingOverrides; settings: null; editorFontZoomLevel: number } => ({
    keybindings: {},
    settings: null,
    editorFontZoomLevel: 0
  })
)

vi.mock('@monaco-editor/react', () => ({
  default: ({ onMount }: { onMount: MountEditor }) => {
    mountEditor = onMount
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof shortcutState) => unknown) => selector(shortcutState),
    { getState: () => shortcutState }
  )
}))
vi.mock('@/components/editor/monaco-content-sync', () => ({
  syncContentOnMount: () => false,
  syncContentUpdate: vi.fn()
}))

type MountEditor = (editor: ReturnType<typeof mountPromptEditor>['editor']) => void
let mountEditor: MountEditor | undefined
let disposeEditor: (() => void) | undefined

function mountPromptEditor() {
  const container = document.createElement('div')
  const input = document.createElement('textarea')
  const runAction = vi.fn()
  const onDownstreamKeyDown = vi.fn()
  input.addEventListener('keydown', onDownstreamKeyDown)
  container.append(input)
  document.body.append(container)
  const editor = {
    getContainerDomNode: () => container,
    getAction: (id: string) => ({ run: () => runAction(id) }),
    onDidDispose: (listener: () => void) => {
      disposeEditor = listener
      return { dispose: vi.fn() }
    }
  }
  render(
    <AutomationEditorPromptEditor
      value="prompt"
      placeholder="Prompt"
      ariaLabel="Prompt"
      onChange={vi.fn()}
    />
  )
  if (!mountEditor) {
    throw new Error('AutomationEditorPromptEditor did not provide an onMount handler')
  }
  mountEditor(editor)
  return { editor, input, runAction, onDownstreamKeyDown }
}

afterEach(() => {
  disposeEditor?.()
  disposeEditor = undefined
  cleanup()
  mountEditor = undefined
  shortcutState.keybindings = {}
  document.body.replaceChildren()
})

describe('AutomationEditorPromptEditor command palette', () => {
  it.each([
    { label: 'disabled', bindings: [] },
    { label: 'remapped', bindings: ['Mod+Shift+P'] }
  ])('blocks Monaco F1 with a diff-only F1 override when $label', ({ bindings }) => {
    shortcutState.keybindings = {
      'editor.nextChange': ['F1'],
      'editor.commandPalette': bindings
    }
    const fixture = mountPromptEditor()

    for (const repeat of [false, true]) {
      const event = new KeyboardEvent('keydown', {
        key: 'F1',
        code: 'F1',
        bubbles: true,
        cancelable: true,
        repeat
      })
      fixture.input.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(fixture.runAction).not.toHaveBeenCalled()
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
  })

  it('runs the remapped palette shortcut alongside a diff-only F1 override', () => {
    shortcutState.keybindings = {
      'editor.nextChange': ['F1'],
      'editor.commandPalette': ['Mod+Shift+P']
    }
    const fixture = mountPromptEditor()
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    fixture.input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.runAction).toHaveBeenCalledExactlyOnceWith('editor.action.quickCommand')
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
  })
})
