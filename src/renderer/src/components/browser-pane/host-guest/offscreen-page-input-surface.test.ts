// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OffscreenPageUserInput } from '../../../../../shared/offscreen-page-protocol'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'
import { bindOffscreenPageInputSurface } from './offscreen-page-input-surface'

const unbinds: (() => void)[] = []

function setup() {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  const canvas = document.createElement('canvas')
  const ime = document.createElement('textarea')
  root.append(canvas, ime)
  document.body.append(host)
  const inputs: OffscreenPageUserInput[] = []
  const sink = {
    input: vi.fn((input: OffscreenPageUserInput) => void inputs.push(input)),
    edit: vi.fn<(action: string) => void>(),
    focusPage: vi.fn<() => void>(),
    setKeyboardFocus: vi.fn<(focused: boolean) => void>(),
    zoom: vi.fn<(direction: 'in' | 'out') => void>(),
    readCaret: vi.fn(() => Promise.resolve({ x: 40, y: 12, height: 18 }))
  }
  const unbind = bindOffscreenPageInputSurface(canvas, ime, sink)
  unbinds.push(unbind)
  return { canvas, ime, sink, inputs, unbind }
}

// Why: happy-dom drops CompositionEventInit.data; Chromium keeps it.
function composition(type: string, data = ''): Event {
  return Object.defineProperty(new Event(type), 'data', { value: data })
}

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('bindOffscreenPageInputSurface', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    for (const unbind of unbinds.splice(0)) {
      unbind()
    }
    vi.restoreAllMocks()
  })

  it('focuses the hidden textarea and the page on mousedown, then places the IME box at the caret', async () => {
    const { canvas, ime, sink, inputs } = setup()
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1
    })
    canvas.dispatchEvent(down)

    expect(down.defaultPrevented).toBe(true)
    expect(sink.focusPage).toHaveBeenCalledOnce()
    expect(inputs[0]).toMatchObject({
      kind: 'mouse',
      type: 'mouseDown',
      button: 'left',
      clickCount: 1
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(ime.style.left).toBe('40px')
    expect(ime.style.top).toBe('12px')
  })

  it('forwards composition as compose updates and a single commit', () => {
    const { ime, inputs } = setup()
    ime.dispatchEvent(composition('compositionstart'))
    ime.dispatchEvent(composition('compositionupdate', 'ni'))
    // Keys typed mid-composition belong to the IME, not the page.
    keydown(ime, { key: 'h', keyCode: 229, isComposing: true })
    ime.dispatchEvent(composition('compositionupdate', 'nih'))
    ime.value = '你好'
    ime.dispatchEvent(new Event('input'))
    ime.dispatchEvent(composition('compositionend', '你好'))

    expect(inputs).toEqual([
      { kind: 'compose', text: 'ni', selectionStart: 2, selectionEnd: 2 },
      { kind: 'compose', text: 'nih', selectionStart: 3, selectionEnd: 3 },
      { kind: 'commit', text: '你好' }
    ])
    expect(ime.value).toBe('')
  })

  it('cancels the page composition when the IME ends with no text', () => {
    const { ime, inputs } = setup()
    ime.dispatchEvent(composition('compositionstart'))
    ime.dispatchEvent(composition('compositionupdate', 'a'))
    ime.dispatchEvent(composition('compositionend', ''))
    expect(inputs.at(-1)).toEqual({ kind: 'cancelComposition' })
  })

  it('forwards a key with its code and text, and keeps it out of the textarea', () => {
    const { ime, inputs } = setup()
    const event = keydown(ime, { key: 'a', code: 'KeyA', keyCode: 65, cancelable: true })
    expect(inputs).toEqual([
      {
        kind: 'key',
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        location: 0,
        repeat: false,
        text: 'a',
        modifiers: []
      }
    ])
    expect(event.defaultPrevented).toBe(true)
  })

  it('types Enter as a carriage return and AltGr characters as text', () => {
    const { ime, inputs } = setup()
    keydown(ime, { key: 'Enter', code: 'Enter', keyCode: 13 })
    keydown(ime, { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true })
    keydown(ime, { key: 'c', code: 'KeyC', ctrlKey: true })
    keydown(ime, { key: 'ArrowLeft', code: 'ArrowLeft' })
    expect(inputs.map((input) => (input.kind === 'key' ? input.text : null))).toEqual([
      '\r',
      '@',
      '',
      ''
    ])
  })

  it('hides page keys from every other key listener, as a focused webview does', () => {
    const { ime, inputs } = setup()
    const orcaShortcut = vi.fn()
    window.addEventListener('keydown', orcaShortcut, true)
    document.addEventListener('keydown', orcaShortcut)
    keydown(ime, { key: 'k', code: 'KeyK', metaKey: true, cancelable: true })
    ime.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'k', code: 'KeyK', bubbles: true, composed: true })
    )
    window.removeEventListener('keydown', orcaShortcut, true)
    document.removeEventListener('keydown', orcaShortcut)
    expect(orcaShortcut).not.toHaveBeenCalled()
    expect(inputs.map((input) => input.kind === 'key' && input.type)).toEqual(['keyDown', 'keyUp'])
  })

  it('ignores keys aimed at anything but the hidden textarea', () => {
    const { inputs } = setup()
    const terminal = document.createElement('textarea')
    document.body.append(terminal)
    keydown(terminal, { key: 'a', cancelable: true })
    expect(inputs).toEqual([])
  })

  it('sends edit chords to the page as keys, and clipboard events as edit commands', () => {
    const { ime, sink, inputs } = setup()
    const paste = new Event('paste', { cancelable: true })
    ime.dispatchEvent(paste)
    const event = keydown(ime, { key: 'c', code: 'KeyC', metaKey: true, cancelable: true })

    expect(paste.defaultPrevented).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(sink.edit.mock.calls).toEqual([['paste']])
    expect(inputs).toMatchObject([{ kind: 'key', code: 'KeyC', modifiers: ['meta'], text: '' }])
  })

  it('maps side buttons and reports held buttons during a drag', () => {
    const { canvas, inputs } = setup()
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 3, buttons: 8, cancelable: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { buttons: 1 | 2 }))
    expect(inputs).toMatchObject([
      { type: 'mouseDown', button: 'back' },
      { type: 'mouseMove', heldButtons: ['left', 'right'] }
    ])
  })

  it('claims Edit menu copy, select all and paste only while the page has focus', () => {
    const { ime, sink } = setup()
    const menu = (type: string, detail?: string) => {
      const event = new CustomEvent(type, { detail, cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(menu(APP_MENU_SELECTION_ACTION_EVENT, 'copy')).toBe(false)
    ime.focus()
    expect(menu(APP_MENU_SELECTION_ACTION_EVENT, 'copy')).toBe(true)
    expect(menu(APP_MENU_SELECTION_ACTION_EVENT, 'select-all')).toBe(true)
    expect(menu(APP_MENU_PASTE_EVENT)).toBe(true)
    expect(sink.edit.mock.calls).toEqual([['copy'], ['selectAll'], ['paste']])
  })

  it('inverts wheel deltas into page scroll deltas', () => {
    const { canvas, inputs } = setup()
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }))
    expect(inputs[0]).toMatchObject({ kind: 'wheel', deltaX: -0, deltaY: -120 })
  })

  it('turns ctrl+wheel into one page zoom step per burst instead of a scroll', () => {
    const { canvas, sink, inputs } = setup()
    const now = vi.spyOn(performance, 'now')
    const wheel = (deltaY: number, at: number) => {
      now.mockReturnValue(at)
      const event = new WheelEvent('wheel', { deltaY, cancelable: true })
      // Why: happy-dom's WheelEvent drops modifier init fields.
      Object.defineProperty(event, 'ctrlKey', { value: true })
      canvas.dispatchEvent(event)
    }
    wheel(-10, 1000)
    wheel(-10, 1020)
    wheel(10, 1200)
    expect(sink.zoom.mock.calls).toEqual([['in'], ['out']])
    expect(inputs).toEqual([])
  })

  it('reports keyboard focus to main while the page owns it, and clears it on unbind', () => {
    const { ime, sink, unbind } = setup()
    ime.focus()
    ime.blur()
    ime.focus()
    unbind()
    expect(sink.setKeyboardFocus.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it('stops forwarding after unbind', () => {
    const { ime, canvas, inputs, unbind } = setup()
    unbind()
    keydown(ime, { key: 'a' })
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(inputs).toEqual([])
  })
})
