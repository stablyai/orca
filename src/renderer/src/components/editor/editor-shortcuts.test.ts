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

import {
  installEditorAddReviewNoteShortcut,
  installEditorFindShortcut,
  installMonacoDiffChangeNavigationShortcut,
  installMonacoEditorFindShortcut,
  installOpenDraftAddReviewNoteGuard
} from './editor-shortcuts'

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

describe('installEditorAddReviewNoteShortcut', () => {
  it('invokes add-review-note on its default binding and honors overrides', () => {
    const container = document.createElement('div')
    const input = document.createElement('textarea')
    const onAddReviewNote = vi.fn(() => true)
    container.appendChild(input)
    document.body.appendChild(container)
    const dispose = installEditorAddReviewNoteShortcut(container, onAddReviewNote)

    const defaultEvent = dispatchKeyDown(input, {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      shiftKey: true
    })
    const repeatEvent = dispatchKeyDown(input, {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      shiftKey: true,
      repeat: true
    })
    const unrelatedEvent = dispatchKeyDown(input, { key: 'a', code: 'KeyA', metaKey: true })

    expect(defaultEvent.defaultPrevented).toBe(true)
    expect(repeatEvent.defaultPrevented).toBe(false)
    expect(unrelatedEvent.defaultPrevented).toBe(false)
    expect(onAddReviewNote).toHaveBeenCalledTimes(1)

    shortcutState.keybindings = { 'editor.addReviewNote': ['Mod+Shift+K'] }
    const overriddenEvent = dispatchKeyDown(input, {
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      shiftKey: true
    })
    expect(overriddenEvent.defaultPrevented).toBe(true)
    expect(onAddReviewNote).toHaveBeenCalledTimes(2)

    dispose()
    dispatchKeyDown(input, { key: 'k', code: 'KeyK', metaKey: true, shiftKey: true })
    expect(onAddReviewNote).toHaveBeenCalledTimes(2)
  })

  it('leaves the chord unconsumed when the handler reports it did not act', () => {
    const container = document.createElement('div')
    const input = document.createElement('textarea')
    const onDownstreamKeyDown = vi.fn()
    const onAddReviewNote = vi.fn(() => false)
    container.appendChild(input)
    document.body.appendChild(container)
    input.addEventListener('keydown', onDownstreamKeyDown)
    const dispose = installEditorAddReviewNoteShortcut(container, onAddReviewNote)

    const event = dispatchKeyDown(input, {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      shiftKey: true
    })

    expect(onAddReviewNote).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
    expect(onDownstreamKeyDown).toHaveBeenCalledTimes(1)
    dispose()
  })
})

describe('installOpenDraftAddReviewNoteGuard', () => {
  it('consumes the add-review-note chord including OS key-repeat (product B)', () => {
    // Why: the guard is scoped to the composer subtree, so mirror that with a
    // container wrapping the focused textarea rather than attaching to window.
    const container = document.createElement('div')
    const input = document.createElement('textarea')
    const onDownstreamKeyDown = vi.fn()
    container.appendChild(input)
    document.body.appendChild(container)
    input.addEventListener('keydown', onDownstreamKeyDown)
    const dispose = installOpenDraftAddReviewNoteGuard(container)

    const first = dispatchKeyDown(input, {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      shiftKey: true
    })
    const repeat = dispatchKeyDown(input, {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      shiftKey: true,
      repeat: true
    })
    const unrelated = dispatchKeyDown(input, { key: 'a', code: 'KeyA', metaKey: true })

    expect(first.defaultPrevented).toBe(true)
    expect(repeat.defaultPrevented).toBe(true)
    expect(unrelated.defaultPrevented).toBe(false)
    // Capture-phase guard stops propagation before the target listener.
    expect(onDownstreamKeyDown).toHaveBeenCalledTimes(1)

    dispose()
    const afterDispose = dispatchKeyDown(input, {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      shiftKey: true
    })
    expect(afterDispose.defaultPrevented).toBe(false)
  })
})

describe('installMonacoDiffChangeNavigationShortcut', () => {
  function createDiffNavigationFixture(): {
    container: HTMLDivElement
    dispose: () => void
    input: HTMLTextAreaElement
    goToDiff: ReturnType<typeof vi.fn>
    onDownstreamKeyDown: ReturnType<typeof vi.fn>
  } {
    const container = document.createElement('div')
    const input = document.createElement('textarea')
    const goToDiff = vi.fn()
    const onDownstreamKeyDown = vi.fn()
    container.appendChild(input)
    document.body.appendChild(container)
    input.addEventListener('keydown', onDownstreamKeyDown)

    return {
      container,
      dispose: installMonacoDiffChangeNavigationShortcut({
        getContainerDomNode: () => container,
        goToDiff
      }),
      input,
      goToDiff,
      onDownstreamKeyDown
    }
  }

  it.each([
    { key: 'F7', shiftKey: false, direction: 'next' },
    { key: 'F7', shiftKey: true, direction: 'previous' }
  ] as const)('routes $key (shift=$shiftKey) to $direction', ({ key, shiftKey, direction }) => {
    const fixture = createDiffNavigationFixture()

    const event = dispatchKeyDown(fixture.input, { key, code: key, shiftKey })

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.goToDiff).toHaveBeenCalledWith(direction)
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('consumes repeats without navigating again', () => {
    const fixture = createDiffNavigationFixture()

    const event = dispatchKeyDown(fixture.input, {
      key: 'F7',
      code: 'F7',
      repeat: true
    })

    expect(event.defaultPrevented).toBe(true)
    expect(fixture.goToDiff).not.toHaveBeenCalled()
    expect(fixture.onDownstreamKeyDown).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it('honors custom bindings and removes the listener when disposed', () => {
    shortcutState.keybindings = { 'editor.nextChange': ['Mod+G'] }
    const fixture = createDiffNavigationFixture()

    const defaultEvent = dispatchKeyDown(fixture.input, { key: 'F7', code: 'F7' })
    const customEvent = dispatchKeyDown(fixture.input, {
      key: 'g',
      code: 'KeyG',
      metaKey: true
    })
    fixture.dispose()
    const disposedEvent = dispatchKeyDown(fixture.input, {
      key: 'g',
      code: 'KeyG',
      metaKey: true
    })

    expect(defaultEvent.defaultPrevented).toBe(false)
    expect(customEvent.defaultPrevented).toBe(true)
    expect(disposedEvent.defaultPrevented).toBe(false)
    expect(fixture.goToDiff).toHaveBeenCalledTimes(1)
    expect(fixture.goToDiff).toHaveBeenCalledWith('next')
  })
})
