// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shortcutState = vi.hoisted(() => ({
  keybindings: {} as Record<string, string[]>,
  platform: 'darwin' as NodeJS.Platform
}))

vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => shortcutState.platform
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ keybindings: shortcutState.keybindings })
  }
}))

import { installEditorFindShortcut, installMonacoEditorFindShortcut } from './editor-shortcuts'

type ShortcutFixture = {
  container: HTMLDivElement
  dispose: () => void
  input: HTMLTextAreaElement
  onDownstreamKeyDown: ReturnType<typeof vi.fn>
  onFind: ReturnType<typeof vi.fn>
}

function createShortcutFixture(): ShortcutFixture {
  const container = document.createElement('div')
  const input = document.createElement('textarea')
  const onDownstreamKeyDown = vi.fn()
  const onFind = vi.fn()

  container.appendChild(input)
  document.body.appendChild(container)
  input.addEventListener('keydown', onDownstreamKeyDown)

  return {
    container,
    dispose: installEditorFindShortcut(container, onFind),
    input,
    onDownstreamKeyDown,
    onFind
  }
}

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

describe('installEditorFindShortcut', () => {
  it.each([
    { label: 'macOS', platform: 'darwin' as const, modifier: { metaKey: true } },
    { label: 'Linux', platform: 'linux' as const, modifier: { ctrlKey: true } },
    { label: 'Windows', platform: 'win32' as const, modifier: { ctrlKey: true } }
  ])('matches logical f on physical KeyU for $label', ({ platform, modifier }) => {
    shortcutState.platform = platform
    const fixture = createShortcutFixture()

    const event = dispatchKeyDown(fixture.input, {
      key: 'f',
      code: 'KeyU',
      ...modifier
    })

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.onFind).toHaveBeenCalledTimes(1)
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('consumes the QWERTY shortcut before Monaco can handle it again', () => {
    const fixture = createShortcutFixture()

    const event = dispatchKeyDown(fixture.input, {
      key: 'f',
      code: 'KeyF',
      metaKey: true
    })

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.onFind).toHaveBeenCalledTimes(1)
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('consumes matched repeats without invoking find again', () => {
    const fixture = createShortcutFixture()

    const initialEvent = dispatchKeyDown(fixture.input, {
      key: 'f',
      code: 'KeyF',
      metaKey: true
    })
    const repeatEvent = dispatchKeyDown(fixture.input, {
      key: 'f',
      code: 'KeyF',
      metaKey: true,
      repeat: true
    })

    expect(initialEvent.defaultPrevented).toBe(true)
    expect(repeatEvent.defaultPrevented).toBe(true)
    expect(fixture.onFind).toHaveBeenCalledTimes(1)
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it.each([
    { label: 'ordinary f typing', init: { key: 'f', code: 'KeyU' } },
    {
      label: 'an unrelated shortcut',
      init: { key: 'g', code: 'KeyG', metaKey: true }
    }
  ])('leaves $label untouched', ({ init }) => {
    const fixture = createShortcutFixture()

    const event = dispatchKeyDown(fixture.input, init)

    expect(event.defaultPrevented).toBe(false)
    expect(fixture.onFind).not.toHaveBeenCalled()
    expect(fixture.onDownstreamKeyDown).toHaveBeenCalledTimes(1)
    fixture.dispose()
  })

  it('honors a custom editor.find binding', () => {
    shortcutState.keybindings = { 'editor.find': ['Mod+G'] }
    const fixture = createShortcutFixture()

    const defaultEvent = dispatchKeyDown(fixture.input, {
      key: 'f',
      code: 'KeyF',
      metaKey: true
    })
    const customEvent = dispatchKeyDown(fixture.input, {
      key: 'g',
      code: 'KeyU',
      metaKey: true
    })

    expect(defaultEvent.defaultPrevented).toBe(false)
    expect(customEvent.defaultPrevented).toBe(true)
    expect(fixture.onFind).toHaveBeenCalledTimes(1)
    expect(fixture.onDownstreamKeyDown).toHaveBeenCalledTimes(1)
    fixture.dispose()
  })

  it('removes the listener when disposed', () => {
    const fixture = createShortcutFixture()
    fixture.dispose()

    const event = dispatchKeyDown(fixture.input, {
      key: 'f',
      code: 'KeyU',
      metaKey: true
    })

    expect(event.defaultPrevented).toBe(false)
    expect(fixture.onFind).not.toHaveBeenCalled()
    expect(fixture.onDownstreamKeyDown).toHaveBeenCalledTimes(1)
  })

  it('runs Monaco existing find action through the shared bridge', () => {
    const container = document.createElement('div')
    const input = document.createElement('textarea')
    const run = vi.fn()
    const getAction = vi.fn((_id: string) => ({ run }))
    container.appendChild(input)
    document.body.appendChild(container)
    const dispose = installMonacoEditorFindShortcut({
      getAction,
      getContainerDomNode: () => container
    })

    dispatchKeyDown(input, { key: 'f', code: 'KeyU', metaKey: true })

    expect(getAction).toHaveBeenCalledWith('actions.find')
    expect(run).toHaveBeenCalledTimes(1)
    dispose()
  })
})
