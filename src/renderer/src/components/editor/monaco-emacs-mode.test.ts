// @vitest-environment happy-dom

import type { editor } from 'monaco-editor'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener<T> = (value: T) => void
type RegisteredCommand = {
  action?: string
  run?: (editorInstance: unknown, extension: unknown, repeat: number, repeated: boolean) => void
}

const unregisterKey = vi.fn()
const registerGlobalCommand = vi.fn<(key: string, command: RegisteredCommand) => void>()
// Why: the monaco-editor mock factory runs at import time, before module-level consts initialise.
const { addKeybindingRules } = vi.hoisted(() => ({
  addKeybindingRules: vi.fn<(rules: { command: string; when: string }[]) => void>()
}))
const keyboardQuitRun = vi.fn()
const started: FakeEmacsExtension[] = []

class FakeEmacsExtension {
  keyListeners: Listener<string>[] = []
  markListeners: Listener<boolean>[] = []
  startCalls = 0
  disposed = false
  readableState = ''
  state = { getReadableState: () => this.readableState }
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
  Actions: {
    RedoAction: class RedoAction {},
    KeyBoardQuit: class KeyBoardQuit {
      run = keyboardQuitRun
    }
  }
}))
vi.mock('monaco-editor', () => ({
  KeyCode: { KeyS: 1, KeyR: 2, KeyG: 3 },
  KeyMod: { WinCtrl: 256 },
  editor: { addKeybindingRules }
}))

import { installMonacoEmacsMode } from './monaco-emacs-mode'

function createFakeEditor() {
  const contextKey = { set: vi.fn(), reset: vi.fn(), get: vi.fn() }
  const fake = {
    createContextKey: vi.fn(() => contextKey),
    trigger: vi.fn(),
    contextKey
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter only uses createContextKey/trigger on the editor and hands it to monaco-emacs, which this test replaces with a fake that never touches it.
  const editorInstance = fake as unknown as editor.IStandaloneCodeEditor
  return { editorInstance, fake }
}

function registeredCommand(key: string): RegisteredCommand | undefined {
  return registerGlobalCommand.mock.calls.find(([name]) => name === key)?.[1]
}

const noopHooks = {
  onSave: () => {},
  onSplitWindow: () => {},
  onOtherWindow: () => {},
  onDeleteWindow: () => {}
}

beforeEach(() => {
  started.length = 0
})

describe('installMonacoEmacsMode', () => {
  it('starts the extension and mirrors prefix keys and the mark into the status node', async () => {
    const statusNode = document.createElement('div')
    await installMonacoEmacsMode(createFakeEditor().editorInstance, statusNode, noopHooks)
    const [extension] = started
    expect(extension?.startCalls).toBe(1)
    expect(statusNode.textContent).toBe('')

    const echo = (state: string): void => {
      if (extension) {
        extension.readableState = state
        extension.keyListeners.forEach((listener) => listener(state))
      }
    }
    echo(' C-x')
    expect(statusNode.textContent).toBe('C-x')

    extension?.markListeners.forEach((listener) => listener(true))
    expect(statusNode.textContent).toBe('C-x  Mark set')

    echo('')
    expect(statusNode.textContent).toBe('Mark set')
  })

  it('clears a finished prefix from the echo once the key handler has returned', async () => {
    const statusNode = document.createElement('div')
    await installMonacoEmacsMode(createFakeEditor().editorInstance, statusNode, noopHooks)
    const extension = started[0]!
    // monaco-emacs echoes `C-x` before running `C-x h`, then resets without firing again.
    extension.readableState = ''
    extension.keyListeners.forEach((listener) => listener('C-x '))
    expect(statusNode.textContent).toBe('C-x')
    await Promise.resolve()
    expect(statusNode.textContent).toBe('')
  })

  it('adjusts the global command table and find-widget rules once across installs', async () => {
    await installMonacoEmacsMode(
      createFakeEditor().editorInstance,
      document.createElement('div'),
      noopHooks
    )
    await installMonacoEmacsMode(
      createFakeEditor().editorInstance,
      document.createElement('div'),
      noopHooks
    )
    expect(unregisterKey.mock.calls.filter(([key]) => key === 'Tab')).toHaveLength(1)
    expect(registerGlobalCommand.mock.calls.map(([key]) => key)).toEqual([
      'C-x h',
      'S-C-/',
      'S-C-M--',
      'S-C-z',
      'C-x C-s',
      'C-x Digit2',
      'C-x Digit3',
      'C-x o',
      'C-x Digit0',
      'C-g'
    ])
    expect(addKeybindingRules).toHaveBeenCalledTimes(1)
    const rules = addKeybindingRules.mock.calls[0]?.[0] ?? []
    expect(rules.map((rule) => rule.command)).toEqual([
      'editor.action.nextMatchFindAction',
      'editor.action.previousMatchFindAction',
      'closeFindWidget'
    ])
    expect(rules.every((rule) => rule.when === 'orcaEmacsKeymap && findWidgetVisible')).toBe(true)
  })

  it('routes C-x C-s to the hooks of the editor that received the key', async () => {
    const first = createFakeEditor()
    const second = createFakeEditor()
    const firstSave = vi.fn()
    const secondSave = vi.fn()
    const firstController = await installMonacoEmacsMode(
      first.editorInstance,
      document.createElement('div'),
      { ...noopHooks, onSave: firstSave }
    )
    await installMonacoEmacsMode(second.editorInstance, document.createElement('div'), {
      ...noopHooks,
      onSave: secondSave
    })

    registeredCommand('C-x C-s')?.run?.(second.editorInstance, null, 1, false)
    expect(secondSave).toHaveBeenCalledTimes(1)
    expect(firstSave).not.toHaveBeenCalled()

    firstController.dispose()
    registeredCommand('C-x C-s')?.run?.(first.editorInstance, null, 1, false)
    expect(firstSave).not.toHaveBeenCalled()
  })

  it('leaves a newer install alone when an install cancelled during the import resolves', async () => {
    const { editorInstance, fake } = createFakeEditor()
    let cancelled = false
    const staleSave = vi.fn()
    const liveSave = vi.fn()
    const stale = installMonacoEmacsMode(
      editorInstance,
      document.createElement('div'),
      { ...noopHooks, onSave: staleSave },
      () => cancelled
    )
    cancelled = true
    const staleController = await stale
    await installMonacoEmacsMode(editorInstance, document.createElement('div'), {
      ...noopHooks,
      onSave: liveSave
    })
    staleController.dispose()

    registeredCommand('C-x C-s')?.run?.(editorInstance, null, 1, false)
    expect(liveSave).toHaveBeenCalledTimes(1)
    expect(staleSave).not.toHaveBeenCalled()
    expect(fake.contextKey.set).not.toHaveBeenCalledWith(false)
  })

  it('routes the window commands to the hooks of the editor that received the key', async () => {
    const { editorInstance } = createFakeEditor()
    const hooks = {
      onSave: vi.fn(),
      onSplitWindow: vi.fn(),
      onOtherWindow: vi.fn(),
      onDeleteWindow: vi.fn()
    }
    const controller = await installMonacoEmacsMode(
      editorInstance,
      document.createElement('div'),
      hooks
    )
    registeredCommand('C-x Digit2')?.run?.(editorInstance, null, 1, false)
    registeredCommand('C-x Digit3')?.run?.(editorInstance, null, 1, false)
    registeredCommand('C-x o')?.run?.(editorInstance, null, 1, false)
    registeredCommand('C-x Digit0')?.run?.(editorInstance, null, 1, false)
    expect(hooks.onSplitWindow.mock.calls).toEqual([['down'], ['right']])
    expect(hooks.onOtherWindow).toHaveBeenCalledTimes(1)
    expect(hooks.onDeleteWindow).toHaveBeenCalledTimes(1)

    controller.dispose()
    registeredCommand('C-x o')?.run?.(editorInstance, null, 1, false)
    expect(hooks.onOtherWindow).toHaveBeenCalledTimes(1)
  })

  it('makes C-g keyboard-quit and close the find widget', async () => {
    const { editorInstance, fake } = createFakeEditor()
    await installMonacoEmacsMode(editorInstance, document.createElement('div'), noopHooks)
    const extension = started[0]
    keyboardQuitRun.mockClear()
    registeredCommand('C-g')?.run?.(editorInstance, extension, 2, true)
    expect(keyboardQuitRun).toHaveBeenCalledWith(editorInstance, extension, 2, true)
    expect(fake.trigger).toHaveBeenCalledWith('orca.emacs', 'closeFindWidget', null)
  })

  it('dispose tears down listeners, the extension, the context key and the status text once', async () => {
    const statusNode = document.createElement('div')
    const { editorInstance, fake } = createFakeEditor()
    const controller = await installMonacoEmacsMode(editorInstance, statusNode, noopHooks)
    expect(fake.createContextKey).toHaveBeenCalledWith('orcaEmacsKeymap', true)
    const [extension] = started
    extension?.markListeners.forEach((listener) => listener(true))
    expect(statusNode.textContent).toBe('Mark set')

    controller.dispose()
    controller.dispose()
    expect(extension?.disposed).toBe(true)
    expect(extension?.keyListeners).toHaveLength(0)
    expect(extension?.markListeners).toHaveLength(0)
    expect(fake.contextKey.set).toHaveBeenCalledWith(false)
    expect(fake.contextKey.set).toHaveBeenCalledTimes(1)
    expect(statusNode.textContent).toBe('')
  })
})
