// @vitest-environment happy-dom

import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import {
  NATIVE_CHAT_STEER_CHORD_HOLD_MS,
  useNativeChatSteerChordPreview
} from './use-native-chat-steer-chord-preview'

vi.mock('./native-chat-shortcut', () => ({ isMacPlatform: () => true }))

type Props = {
  alternateSend: NativeChatFollowUpBehavior | undefined
  hasDraft: boolean
  steerHead: (() => boolean) | undefined
  send: () => void
  pickerOpen: boolean
}

function Composer(props: Props): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const { alternateSend, hasDraft, steerHead, send, pickerOpen } = props
  const { preview, runPreview } = useNativeChatSteerChordPreview(
    root,
    { alternateSend, hasDraft },
    steerHead,
    send,
    pickerOpen
  )
  return (
    <div ref={root}>
      <textarea aria-label="composer" />
      <button type="button" data-preview={preview ?? ''} onClick={runPreview}>
        send
      </button>
    </div>
  )
}

describe('useNativeChatSteerChordPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function setup(overrides: Partial<Props> = {}) {
    const props: Props = {
      alternateSend: 'steer',
      hasDraft: false,
      steerHead: vi.fn(() => true),
      send: vi.fn(),
      pickerOpen: false,
      ...overrides
    }
    const view = render(<Composer {...props} />)
    const field = view.getByLabelText('composer')
    const button = view.getByRole('button')
    const hold = () => {
      fireEvent.keyDown(field, { key: 'Meta' })
      act(() => vi.advanceTimersByTime(NATIVE_CHAT_STEER_CHORD_HOLD_MS))
    }
    return { props, view, field, button, hold, preview: () => button.dataset.preview }
  }

  it('previews steering the head card while Cmd is held alone on an empty composer', () => {
    const { props, field, button, hold, preview } = setup()
    hold()
    expect(preview()).toBe('steer-queued')
    fireEvent.click(button)
    expect(props.steerHead).toHaveBeenCalledTimes(1)
    fireEvent.keyUp(field, { key: 'Meta' })
    expect(preview()).toBe('')
  })

  it('names what Cmd+Enter does to a typed draft, and a click sends it that way', () => {
    const { props, button, hold, preview } = setup({ alternateSend: 'queue', hasDraft: true })
    hold()
    expect(preview()).toBe('queue')
    fireEvent.click(button)
    expect(props.send).toHaveBeenCalledWith({ alternate: true })
    expect(props.steerHead).not.toHaveBeenCalled()
  })

  it('shows nothing when Shift is already down, since Cmd+Shift+Enter is another chord', () => {
    const { field, preview } = setup({ hasDraft: true })
    fireEvent.keyDown(field, { key: 'Meta', shiftKey: true })
    act(() => vi.advanceTimersByTime(NATIVE_CHAT_STEER_CHORD_HOLD_MS))
    expect(preview()).toBe('')
  })

  it('never flashes for a quick chord such as Cmd+C', () => {
    const { field, preview } = setup()
    fireEvent.keyDown(field, { key: 'Meta' })
    fireEvent.keyDown(field, { key: 'c', metaKey: true })
    act(() => vi.advanceTimersByTime(NATIVE_CHAT_STEER_CHORD_HOLD_MS * 2))
    expect(preview()).toBe('')
  })

  it('releases when the window loses focus, since macOS drops the key-up after Cmd+Tab', () => {
    const { hold, preview } = setup()
    hold()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(preview()).toBe('')
  })

  it('adds window listeners only for the composer holding a preview, however many chats are busy', () => {
    const windowListeners = vi.spyOn(window, 'addEventListener')
    const blurListeners = () => windowListeners.mock.calls.filter(([type]) => type === 'blur')
    const busyChats = Array.from({ length: 10 }, () => setup())
    expect(blurListeners()).toHaveLength(0)
    busyChats[0].hold()
    expect(blurListeners()).toHaveLength(1)
  })

  it.each([
    ['the chord queues', { alternateSend: 'queue' as const }],
    ['there is no card to steer', { steerHead: undefined }],
    ['a picker takes Enter', { pickerOpen: true }]
  ])('shows nothing on an empty composer where %s', (_case, overrides) => {
    const { hold, preview } = setup(overrides)
    hold()
    expect(preview()).toBe('')
  })
})
