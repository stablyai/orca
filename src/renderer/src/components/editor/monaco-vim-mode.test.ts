// @vitest-environment happy-dom
import * as monaco from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import { attachMonacoVimMode, shouldAttachEditorVim } from './monaco-vim-mode'

// Why: happy-dom has no 2D canvas; Monaco reads pixel ratio and paints via ctx, so return a permissive no-op.
const canvasContextStub = new Proxy(
  {
    webkitBackingStorePixelRatio: 1,
    mozBackingStorePixelRatio: 1,
    msBackingStorePixelRatio: 1,
    oBackingStorePixelRatio: 1,
    backingStorePixelRatio: 1,
    canvas: null
  },
  {
    get(target, prop) {
      if (prop in target) {
        return (target as Record<PropertyKey, unknown>)[prop]
      }
      return () => undefined
    }
  }
)
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
  canvasContextStub as unknown as CanvasRenderingContext2D
)

function createEditor(content = 'hello\n') {
  const host = document.createElement('div')
  host.style.width = '800px'
  host.style.height = '600px'
  document.body.appendChild(host)
  const model = monaco.editor.createModel(content, 'plaintext')
  const editor = monaco.editor.create(host, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    renderOverviewRuler: false,
    // Why: wordHighlighter's delayed promise rejects Canceled on dispose and pollutes unhandled errors.
    occurrencesHighlight: 'off'
  })
  const status = document.createElement('div')
  document.body.appendChild(status)
  return { host, model, editor, status }
}

function key(element: HTMLElement, init: KeyboardEventInit): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

async function attachVim(editor: monaco.editor.IStandaloneCodeEditor, status: HTMLElement) {
  const onWrite = vi.fn()
  const onWriteRef = { current: onWrite }
  const controller = new AbortController()
  const attachment = await attachMonacoVimMode({
    editor,
    statusNode: status,
    onWriteRef,
    signal: controller.signal
  })
  return { attachment, onWrite }
}

describe('shouldAttachEditorVim', () => {
  it('gates on preset, readOnly, autoHeight', () => {
    expect(shouldAttachEditorVim({ preset: 'vim', readOnly: false, autoHeight: false })).toBe(true)
    expect(shouldAttachEditorVim({ preset: 'default', readOnly: false, autoHeight: false })).toBe(
      false
    )
    expect(shouldAttachEditorVim({ preset: 'vim', readOnly: true, autoHeight: false })).toBe(false)
    expect(shouldAttachEditorVim({ preset: 'vim', readOnly: false, autoHeight: true })).toBe(false)
  })
})

describe('attachMonacoVimMode', () => {
  it('attaches in normal mode and maps motions/edits/Escape', async () => {
    const { host, model, editor, status } = createEditor('hello\n')
    const { attachment } = await attachVim(editor, status)

    expect(status.textContent).toContain('--NORMAL--')

    editor.setPosition({ lineNumber: 1, column: 1 })
    const container = editor.getContainerDomNode()
    const input = (container.querySelector('textarea') ?? container) as HTMLElement
    key(input, { key: 'x', code: 'KeyX' })
    expect(model.getValue()).toBe('ello\n')

    key(input, { key: 'i', code: 'KeyI' })
    expect(status.textContent).toContain('--INSERT--')

    key(input, { key: 'Escape', code: 'Escape', keyCode: 27 })
    expect(status.textContent).toContain('--NORMAL--')

    attachment.dispose()
    editor.dispose()
    model.dispose()
    host.remove()
    status.remove()
  })

  it('routes :w through the focused editor write callback', async () => {
    const { host, model, editor, status } = createEditor('hello\n')
    editor.focus()
    const focusedSpy = vi.spyOn(editor, 'hasTextFocus').mockReturnValue(true)
    const { attachment, onWrite } = await attachVim(editor, status)

    const container = editor.getContainerDomNode()
    const input = (container.querySelector('textarea') ?? container) as HTMLElement
    // Why: ':' opens the status-node Ex input; write 'w' there and submit Enter.
    key(input, { key: ':', code: 'Semicolon', shiftKey: true })
    const exInput = status.querySelector('input')
    expect(exInput).toBeTruthy()
    exInput!.value = 'w'
    key(exInput!, { key: 'Enter', code: 'Enter', keyCode: 13 })
    expect(onWrite).toHaveBeenCalledTimes(1)

    attachment.dispose()
    focusedSpy.mockRestore()
    editor.dispose()
    model.dispose()
    host.remove()
    status.remove()
  })

  it('saves the originating split editor even when another editor last claimed focus', async () => {
    const first = createEditor('first\n')
    const second = createEditor('second\n')
    const focusedSpy = vi.spyOn(first.editor, 'hasTextFocus').mockReturnValue(true)
    const focusEventSpy = vi
      .spyOn(second.editor, 'onDidFocusEditorText')
      .mockReturnValue({ dispose() {} })
    const firstVim = await attachVim(first.editor, first.status)
    const secondVim = await attachVim(second.editor, second.status)
    try {
      const input = second.host.querySelector('textarea')
      if (!input) {
        throw new Error('Missing second editor input')
      }
      key(input, { key: ':', code: 'Semicolon', shiftKey: true })
      const exInput = second.status.querySelector('input')
      if (!exInput) {
        throw new Error('Missing second editor Ex input')
      }
      exInput.value = 'w'
      key(exInput, { key: 'Enter', code: 'Enter', keyCode: 13 })
      expect(secondVim.onWrite).toHaveBeenCalledTimes(1)
      expect(firstVim.onWrite).not.toHaveBeenCalled()
    } finally {
      firstVim.attachment.dispose()
      secondVim.attachment.dispose()
      focusedSpy.mockRestore()
      focusEventSpy.mockRestore()
      for (const surface of [first, second]) {
        surface.editor.dispose()
        surface.model.dispose()
        surface.host.remove()
        surface.status.remove()
      }
    }
  })

  it('keeps Escape on find-widget close instead of vim, and normal Escape passes through', async () => {
    const { host, model, editor, status } = createEditor('hello\n')
    const { attachment } = await attachVim(editor, status)

    const container = editor.getContainerDomNode()
    const input = (container.querySelector('textarea') ?? container) as HTMLElement

    // Why: happy-dom never opens Monaco's find widget; simulate its open DOM state and
    // verify Escape dispatches the close command instead of reaching vim.
    const openWidget = document.createElement('div')
    openWidget.className = 'find-widget'
    container.appendChild(openWidget)
    const triggerSpy = vi.spyOn(editor, 'trigger')

    key(input, { key: 'Escape', code: 'Escape', keyCode: 27 })
    expect(triggerSpy).toHaveBeenCalledWith('keyboard', 'closeFindWidget', null)

    openWidget.remove()

    // With the widget closed, Escape must reach vim (exits any pending operator, stays normal).
    key(input, { key: 'i', code: 'KeyI' })
    expect(status.textContent).toContain('--INSERT--')
    key(input, { key: 'Escape', code: 'Escape', keyCode: 27 })
    expect(status.textContent).toContain('--NORMAL--')

    attachment.dispose()
    editor.dispose()
    model.dispose()
    host.remove()
    status.remove()
  })

  it('dispose removes vim handling so letters type again', async () => {
    const { host, model, editor, status } = createEditor('hello\n')
    const { attachment } = await attachVim(editor, status)
    expect(status.textContent).toContain('--NORMAL--')

    attachment.dispose()

    const container = editor.getContainerDomNode()
    const input = (container.querySelector('textarea') ?? container) as HTMLElement
    editor.setPosition({ lineNumber: 1, column: 1 })
    // Why: after detach the editor is plain Monaco — 'x' types instead of deleting.
    key(input, { key: 'x', code: 'KeyX' })
    // happy-dom may not fire beforeinput/insertText; accept either no vim delete or literal insert.
    expect(model.getValue()).not.toBe('ello\n')

    editor.dispose()
    model.dispose()
    host.remove()
    status.remove()
  })
})
