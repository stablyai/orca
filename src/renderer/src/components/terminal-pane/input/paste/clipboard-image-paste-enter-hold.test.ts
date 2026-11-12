import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipboardImagePasteEnterHold } from './clipboard-image-paste-enter-hold'

function fakeTextarea(paneId: number): HTMLElement {
  const textarea = {
    classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
    closest: (selector: string) =>
      selector === '.pane'
        ? { getAttribute: (name: string) => (name === 'data-pane-id' ? String(paneId) : null) }
        : null
  }
  return textarea as unknown as HTMLElement
}

function enterEvent(
  target: EventTarget | null,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  return {
    key: 'Enter',
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
    target,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  } as unknown as KeyboardEvent
}

function escapeEvent(target: EventTarget | null): KeyboardEvent {
  return {
    key: 'Escape',
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  } as unknown as KeyboardEvent
}

describe('clipboard image paste Enter hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup() {
    const input = vi.fn()
    const hold = createClipboardImagePasteEnterHold({
      getPanes: () => [{ id: 7, terminal: { input } }]
    })
    return { hold, input }
  }

  it('holds Enter typed during the upload and presses it after the path lands', () => {
    const { hold, input } = setup()
    hold.noteImageUploadStart(7)

    const event = enterEvent(fakeTextarea(7))
    hold.handleKeyDown(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()

    hold.settleImageUpload(7, true)
    expect(input).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(input).toHaveBeenCalledWith('\r')
  })

  it('drops the held Enter when the upload fails', () => {
    const { hold, input } = setup()
    hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))

    hold.settleImageUpload(7, false)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })

  it('Esc cancels the held Enter', () => {
    const { hold, input } = setup()
    hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))
    hold.handleKeyDown(escapeEvent(fakeTextarea(7)))

    hold.settleImageUpload(7, true)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })

  it('leaves Enter alone outside an upload or in another pane', () => {
    const { hold, input } = setup()
    const beforeUpload = enterEvent(fakeTextarea(7))
    hold.handleKeyDown(beforeUpload)
    expect(beforeUpload.preventDefault).not.toHaveBeenCalled()

    hold.noteImageUploadStart(7)
    const otherPane = enterEvent(fakeTextarea(9))
    hold.handleKeyDown(otherPane)
    expect(otherPane.preventDefault).not.toHaveBeenCalled()

    hold.handleKeyDown(enterEvent(fakeTextarea(7), { shiftKey: true }))
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })
})
