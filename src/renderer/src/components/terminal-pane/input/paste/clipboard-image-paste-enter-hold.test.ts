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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture carries only the shape eventTargetPaneId probes.
  return textarea as unknown as HTMLElement
}

function keyEvent(
  key: string,
  target: EventTarget | null,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  const partial = {
    key,
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
    target,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial keyboard event carrying only plain-key fields.
  return partial as unknown as KeyboardEvent
}

function enterEvent(
  target: EventTarget | null,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  return keyEvent('Enter', target, overrides)
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
      getPanes: () => [
        { id: 7, terminal: { input } },
        { id: 9, terminal: { input } }
      ]
    })
    return { hold, input }
  }

  it('holds Enter typed during the upload and presses it after the path lands', () => {
    const { hold, input } = setup()
    const token = hold.noteImageUploadStart(7)

    const event = enterEvent(fakeTextarea(7))
    hold.handleKeyDown(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()

    hold.settleImageUpload(token, true)
    expect(input).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(input).toHaveBeenCalledWith('\r')
  })

  it('suppresses auto-repeated Enter while the upload is active', () => {
    const { hold, input } = setup()
    hold.noteImageUploadStart(7)

    const repeat = enterEvent(fakeTextarea(7), { repeat: true })
    hold.handleKeyDown(repeat)
    expect(repeat.preventDefault).toHaveBeenCalled()

    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })

  it('drops the held Enter when the upload fails', () => {
    const { hold, input } = setup()
    const token = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))

    hold.settleImageUpload(token, false)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })

  it('Esc cancels the held Enter', () => {
    const { hold, input } = setup()
    const token = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))
    hold.handleKeyDown(keyEvent('Escape', fakeTextarea(7)))

    hold.settleImageUpload(token, true)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })

  it('ignores a settlement from a paste that never started an image upload', () => {
    const { hold, input } = setup()
    const token = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))

    // A text paste in the same pane completes first; its stale settlement must not release anything.
    hold.settleImageUpload({ paneId: 7, run: token.run + 100 }, false)
    hold.settleImageUpload(token, true)
    vi.advanceTimersByTime(50)
    expect(input).toHaveBeenCalledWith('\r')
  })

  it('tracks overlapping uploads and held Enters per pane', () => {
    const { hold, input } = setup()
    const tokenA = hold.noteImageUploadStart(7)
    const tokenB = hold.noteImageUploadStart(9)

    const enterA = enterEvent(fakeTextarea(7))
    hold.handleKeyDown(enterA)
    const enterB = enterEvent(fakeTextarea(9))
    hold.handleKeyDown(enterB)
    expect(enterA.preventDefault).toHaveBeenCalled()
    expect(enterB.preventDefault).toHaveBeenCalled()

    hold.settleImageUpload(tokenA, true)
    vi.advanceTimersByTime(50)
    expect(input).toHaveBeenCalledWith('\r')

    hold.settleImageUpload(tokenB, true)
    vi.advanceTimersByTime(50)
    expect(input).toHaveBeenCalledTimes(2)
  })

  it('keeps the hold while another upload in the same pane is still running', () => {
    const { hold, input } = setup()
    const first = hold.noteImageUploadStart(7)
    const second = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))

    hold.settleImageUpload(first, true)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()

    const late = enterEvent(fakeTextarea(7))
    hold.handleKeyDown(late)
    expect(late.preventDefault).toHaveBeenCalled()

    hold.settleImageUpload(second, true)
    vi.advanceTimersByTime(50)
    expect(input).toHaveBeenCalledWith('\r')
  })

  it('defers a scheduled Enter when another upload starts inside the post-paste delay', () => {
    const { hold, input } = setup()
    const first = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))
    hold.settleImageUpload(first, true)

    const second = hold.noteImageUploadStart(7)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()

    hold.settleImageUpload(second, true)
    vi.advanceTimersByTime(50)
    expect(input).toHaveBeenCalledWith('\r')
  })

  it('cancels the held Enter when one of two overlapping uploads fails first', () => {
    const { hold, input } = setup()
    const first = hold.noteImageUploadStart(7)
    const second = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))

    hold.settleImageUpload(first, false)
    hold.settleImageUpload(second, true)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })

  it('cancels the held Enter when one of two overlapping uploads fails last', () => {
    const { hold, input } = setup()
    const first = hold.noteImageUploadStart(7)
    const second = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))

    hold.settleImageUpload(first, true)
    hold.settleImageUpload(second, false)
    vi.advanceTimersByTime(50)
    expect(input).not.toHaveBeenCalled()
  })

  it('dispose clears pending state so a stale timer cannot reach a remounted pane', () => {
    const { hold, input } = setup()
    const token = hold.noteImageUploadStart(7)
    hold.handleKeyDown(enterEvent(fakeTextarea(7)))
    hold.settleImageUpload(token, true)

    hold.dispose()
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
