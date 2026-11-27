// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'

function makeComposer(overrides: Partial<NativeChatComposerHandle> = {}): NativeChatComposerHandle {
  return {
    insertAgentReferences: () => false,
    focus: () => true,
    insertTypedText: () => false,
    acceptsText: () => true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false,
    ...overrides
  }
}

function makeKeyEvent(
  target: EventTarget,
  overrides: Partial<{
    key: string
    code: string
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
    altKey: boolean
    isComposing: boolean
    keyCode: number
    repeat: boolean
    defaultPrevented: boolean
  }> = {}
) {
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  const isMac = navigator.userAgent.includes('Mac')
  return {
    key: 'P',
    code: 'KeyP',
    ctrlKey: !isMac,
    metaKey: isMac,
    shiftKey: true,
    altKey: false,
    isComposing: false,
    keyCode: 80,
    repeat: false,
    defaultPrevented: false,
    target,
    preventDefault,
    stopPropagation,
    ...overrides
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('routeNativeChatRootKeyToInput work-target shortcut', () => {
  it('opens the picker from pane root and body (including Korean KeyP), while respecting editable targets, IME, overlays, and non-bot chats', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const openWorkTargetPicker = vi.fn(() => true)
    const composer = makeComposer({ openWorkTargetPicker })

    // Non-editable pane root opens the picker.
    const rootEvent = makeKeyEvent(root)
    routeNativeChatRootKeyToInput(rootEvent, composer, null)
    expect(openWorkTargetPicker).toHaveBeenCalledTimes(1)
    expect(rootEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(rootEvent.stopPropagation).toHaveBeenCalledTimes(1)

    // Unclaimed body focus with Korean layout physical KeyP opens the picker.
    const koreanBodyEvent = makeKeyEvent(document.body, { key: 'ㅔ', code: 'KeyP' })
    routeNativeChatRootKeyToInput(koreanBodyEvent, composer, null)
    expect(openWorkTargetPicker).toHaveBeenCalledTimes(2)
    expect(koreanBodyEvent.preventDefault).toHaveBeenCalledTimes(1)

    // IME composing never triggers the shortcut.
    const imeEvent = makeKeyEvent(root, { isComposing: true, keyCode: 229 })
    routeNativeChatRootKeyToInput(imeEvent, composer, null)
    expect(openWorkTargetPicker).toHaveBeenCalledTimes(2)
    expect(imeEvent.preventDefault).not.toHaveBeenCalled()

    // Editable controls keep their own key handling (composer editor handles its own keydown).
    const input = document.createElement('input')
    root.appendChild(input)
    const inputEvent = makeKeyEvent(input)
    routeNativeChatRootKeyToInput(inputEvent, composer, null)
    expect(openWorkTargetPicker).toHaveBeenCalledTimes(2)
    expect(inputEvent.preventDefault).not.toHaveBeenCalled()

    // Non-bot chats without openWorkTargetPicker do not swallow the chord.
    const nonBotEvent = makeKeyEvent(root)
    routeNativeChatRootKeyToInput(nonBotEvent, makeComposer(), null)
    expect(nonBotEvent.preventDefault).not.toHaveBeenCalled()
    expect(nonBotEvent.stopPropagation).not.toHaveBeenCalled()

    // Visible overlays own their own keyboard shortcuts.
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    const overlayEvent = makeKeyEvent(root)
    routeNativeChatRootKeyToInput(overlayEvent, composer, null)
    expect(openWorkTargetPicker).toHaveBeenCalledTimes(2)
    expect(overlayEvent.preventDefault).not.toHaveBeenCalled()
  })
})
