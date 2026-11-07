// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shortcutState = vi.hoisted(
  (): { keybindings: Record<string, string[]>; platform: NodeJS.Platform } => ({
    keybindings: {},
    platform: 'darwin'
  })
)

vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => shortcutState.platform
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ keybindings: shortcutState.keybindings })
  }
}))

import { installEditorCommandPaletteShortcut } from './editor-shortcuts'

function dispatchKeyDown(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    ...init,
    bubbles: true,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  shortcutState.keybindings = {}
  shortcutState.platform = 'darwin'
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('installEditorCommandPaletteShortcut', () => {
  function createCommandPaletteFixture(): {
    container: HTMLDivElement
    dispose: () => void
    input: HTMLTextAreaElement
    onCommandPalette: ReturnType<typeof vi.fn>
    onDownstreamKeyDown: ReturnType<typeof vi.fn>
  } {
    const container = document.createElement('div')
    const input = document.createElement('textarea')
    const onCommandPalette = vi.fn()
    const onDownstreamKeyDown = vi.fn()
    container.appendChild(input)
    document.body.appendChild(container)
    input.addEventListener('keydown', onDownstreamKeyDown)

    return {
      container,
      dispose: installEditorCommandPaletteShortcut(container, onCommandPalette),
      input,
      onCommandPalette,
      onDownstreamKeyDown
    }
  }

  it('triggers on default F1 keydown', () => {
    const fixture = createCommandPaletteFixture()

    const event = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.onCommandPalette).toHaveBeenCalledTimes(1)
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('consumes matched repeats without invoking command palette again', () => {
    const fixture = createCommandPaletteFixture()

    const initialEvent = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })
    const repeatEvent = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1', repeat: true })

    expect(initialEvent.defaultPrevented).toBe(true)
    expect(repeatEvent.defaultPrevented).toBe(true)
    expect(fixture.onCommandPalette).toHaveBeenCalledTimes(1)
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('honors a custom binding and consumes the old Monaco default', () => {
    shortcutState.keybindings = { 'editor.commandPalette': ['Mod+Shift+P'] }
    const fixture = createCommandPaletteFixture()

    const defaultEvent = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })
    const customEvent = dispatchKeyDown(fixture.input, {
      key: 'p',
      code: 'KeyP',
      metaKey: true,
      shiftKey: true
    })

    expect(defaultEvent.defaultPrevented).toBe(true)
    expect(customEvent.defaultPrevented).toBe(true)
    expect(fixture.onCommandPalette).toHaveBeenCalledTimes(1)
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('consumes F1 without opening the palette when the action is disabled', () => {
    shortcutState.keybindings = { 'editor.commandPalette': [] }
    const fixture = createCommandPaletteFixture()

    const event = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.onCommandPalette).not.toHaveBeenCalled()
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'blocks F1 without a diff handler on %s and restores the palette after reset',
    (platform) => {
      shortcutState.platform = platform
      shortcutState.keybindings = { 'editor.nextChange': ['F1'] }
      const fixture = createCommandPaletteFixture()

      const blocked = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })

      expect(blocked.defaultPrevented).toBe(true)
      expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
      expect(fixture.onCommandPalette).not.toHaveBeenCalled()

      shortcutState.keybindings = {}
      dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })

      expect(fixture.onCommandPalette).toHaveBeenCalledTimes(1)
      fixture.dispose()
    }
  )

  it.each([
    { label: 'remapped', bindings: ['Mod+Shift+P'] },
    { label: 'disabled', bindings: [] }
  ])('blocks an unavailable diff action’s F1 when the palette is $label', ({ bindings }) => {
    shortcutState.keybindings = {
      'editor.commandPalette': bindings,
      'editor.nextChange': ['F1']
    }
    const fixture = createCommandPaletteFixture()

    const event = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.onCommandPalette).not.toHaveBeenCalled()
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('removes the listener when disposed', () => {
    const fixture = createCommandPaletteFixture()
    fixture.dispose()

    const event = dispatchKeyDown(fixture.input, { key: 'F1', code: 'F1' })

    expect(event.defaultPrevented).toBe(false)
    expect(fixture.onCommandPalette).not.toHaveBeenCalled()
    expect(fixture.onDownstreamKeyDown).toHaveBeenCalledTimes(1)
  })
})
