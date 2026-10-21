// @vitest-environment happy-dom

import type { editor } from 'monaco-editor'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener<T> = (value: T) => void

const unregisterKey = vi.fn()
const registerGlobalCommand = vi.fn()
const started: FakeEmacsExtension[] = []

class FakeEmacsExtension {
  keyListeners: Listener<string>[] = []
  markListeners: Listener<boolean>[] = []
  startCalls = 0
  disposed = false
  constructor(readonly editor: editor.IStandaloneCodeEditor) {
    started.push(this)
  }
  onDidChangeKey = (listener: Listener<string>) => {
    this.keyListeners.push(listener)
    return { dispose: () => this.keyListeners.splice(this.keyListeners.indexOf(listener), 1) }
  }
  onDidMarkChange = (listener: Listener<boolean>) => {
    this.markListeners.push(listener)
    return { dispose: () => this.markListeners.splice(this.markListeners.indexOf(listener), 1) }
  }
  start(): void {
    this.startCalls += 1
  }
  dispose(): void {
    this.disposed = true
  }
}

vi.mock('monaco-emacs', () => ({
  EmacsExtension: FakeEmacsExtension,
  unregisterKey,
  registerGlobalCommand,
  Actions: { RedoAction: class RedoAction {} }
}))

import { installMonacoEmacsMode } from './monaco-emacs-mode'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter only forwards the editor to monaco-emacs, which this test replaces with a fake that never touches it.
const fakeEditor = {} as editor.IStandaloneCodeEditor

beforeEach(() => {
  started.length = 0
})

describe('installMonacoEmacsMode', () => {
  it('starts the extension and mirrors prefix keys and the mark into the status node', async () => {
    const statusNode = document.createElement('div')
    await installMonacoEmacsMode(fakeEditor, statusNode)
    const [extension] = started
    expect(extension?.startCalls).toBe(1)
    expect(statusNode.textContent).toBe('')

    extension?.keyListeners.forEach((listener) => listener(' C-x'))
    expect(statusNode.textContent).toBe('C-x')

    extension?.markListeners.forEach((listener) => listener(true))
    expect(statusNode.textContent).toBe('C-x  Mark set')

    extension?.keyListeners.forEach((listener) => listener(''))
    expect(statusNode.textContent).toBe('Mark set')
  })

  it('adjusts the global command table once across installs', async () => {
    await installMonacoEmacsMode(fakeEditor, document.createElement('div'))
    await installMonacoEmacsMode(fakeEditor, document.createElement('div'))
    expect(unregisterKey.mock.calls.filter(([key]) => key === 'Tab')).toHaveLength(1)
    expect(registerGlobalCommand.mock.calls.map(([key]) => key)).toEqual(['C-x h', 'S-C-z'])
  })

  it('dispose tears down listeners, the extension, and the status text exactly once', async () => {
    const statusNode = document.createElement('div')
    const controller = await installMonacoEmacsMode(fakeEditor, statusNode)
    const [extension] = started
    extension?.markListeners.forEach((listener) => listener(true))
    expect(statusNode.textContent).toBe('Mark set')

    controller.dispose()
    controller.dispose()
    expect(extension?.disposed).toBe(true)
    expect(extension?.keyListeners).toHaveLength(0)
    expect(extension?.markListeners).toHaveLength(0)
    expect(statusNode.textContent).toBe('')
  })
})
