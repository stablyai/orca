// @vitest-environment happy-dom

import type { editor } from 'monaco-editor'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener<T> = (value: T) => void

type StartedExtension = {
  keyListeners: Listener<string>[]
  markListeners: Listener<boolean>[]
  startCalls: number
  disposed: boolean
}

const { unregisterKey, registerGlobalCommand, started } = vi.hoisted(() => {
  const started: StartedExtension[] = []
  return { unregisterKey: vi.fn(), registerGlobalCommand: vi.fn(), started }
})

vi.mock('monaco-emacs', () => {
  class FakeEmacsExtension {
    keyListeners: Listener<string>[] = []
    markListeners: Listener<boolean>[] = []
    startCalls = 0
    disposed = false
    readableState = ''
    state = { getReadableState: () => this.readableState }
    constructor() {
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
  return {
    EmacsExtension: FakeEmacsExtension,
    unregisterKey,
    registerGlobalCommand,
    Actions: { RedoAction: class RedoAction {} }
  }
})

import { installMonacoEmacsMode } from './monaco-emacs-mode'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter only forwards the editor to monaco-emacs, which this test replaces with a fake that never touches it.
const fakeEditor = {} as editor.IStandaloneCodeEditor
const noopHooks = { onSave: () => {} }

function registeredCommand(key: string): { run: (target: editor.IStandaloneCodeEditor) => void } {
  return registerGlobalCommand.mock.calls.find(([registered]) => registered === key)?.[1]
}

beforeEach(() => {
  started.length = 0
})

describe('installMonacoEmacsMode', () => {
  it('starts the extension and mirrors prefix keys and the mark into the status node', async () => {
    const statusNode = document.createElement('div')
    await installMonacoEmacsMode(fakeEditor, statusNode, noopHooks)
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

  it('clears a finished prefix from the echo once the key handler has returned', async () => {
    const statusNode = document.createElement('div')
    await installMonacoEmacsMode(fakeEditor, statusNode, noopHooks)
    const [extension] = started
    // monaco-emacs echoes `C-x` before running `C-x h`, then resets without firing again.
    extension?.keyListeners.forEach((listener) => listener('C-x '))
    expect(statusNode.textContent).toBe('C-x')
    await Promise.resolve()
    expect(statusNode.textContent).toBe('')
  })

  it('adjusts the global command table once across installs', async () => {
    await installMonacoEmacsMode(fakeEditor, document.createElement('div'), noopHooks)
    await installMonacoEmacsMode(fakeEditor, document.createElement('div'), noopHooks)
    expect(unregisterKey.mock.calls.filter(([key]) => key === 'Tab')).toHaveLength(1)
    expect(registerGlobalCommand.mock.calls.map(([key]) => key)).toEqual([
      'C-x h',
      'S-C-z',
      'C-x C-s'
    ])
  })

  it('routes C-x C-s to the hooks of the editor that received the key', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only used as a WeakMap key by the adapter; monaco-emacs is faked.
    const otherEditor = {} as editor.IStandaloneCodeEditor
    const save = vi.fn()
    const otherSave = vi.fn()
    const controller = await installMonacoEmacsMode(fakeEditor, document.createElement('div'), {
      onSave: save
    })
    await installMonacoEmacsMode(otherEditor, document.createElement('div'), { onSave: otherSave })

    registeredCommand('C-x C-s').run(otherEditor)
    expect(otherSave).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()

    controller.dispose()
    registeredCommand('C-x C-s').run(fakeEditor)
    expect(save).not.toHaveBeenCalled()
  })

  it('does not start an install cancelled while monaco-emacs loads', async () => {
    const statusNode = document.createElement('div')
    statusNode.textContent = 'newer install'
    const controller = await installMonacoEmacsMode(fakeEditor, statusNode, noopHooks, () => true)
    controller.dispose()
    expect(started).toHaveLength(0)
    expect(statusNode.textContent).toBe('newer install')
  })

  it('dispose tears down listeners, the extension, and the status text exactly once', async () => {
    const statusNode = document.createElement('div')
    const controller = await installMonacoEmacsMode(fakeEditor, statusNode, noopHooks)
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
