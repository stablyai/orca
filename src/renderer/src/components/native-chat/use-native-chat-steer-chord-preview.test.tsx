// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
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
  chordSteersHead: boolean
  steerHead: (() => boolean) | undefined
  send: () => void
  pickerOpen: boolean
}

function Composer(props: Props): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const { alternateSend, hasDraft, chordSteersHead, steerHead, send, pickerOpen } = props
  const { preview, runPreview } = useNativeChatSteerChordPreview(
    root,
    { alternateSend, hasDraft, chordSteersHead },
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
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function setup(overrides: Partial<Props> = {}) {
    const props: Props = {
      alternateSend: 'steer',
      hasDraft: false,
      chordSteersHead: true,
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

  it('shows nothing while an IME composes, since the IME owns Enter then', () => {
    const { field, preview } = setup({ hasDraft: true })
    fireEvent.keyDown(field, { key: 'Meta', isComposing: true })
    act(() => vi.advanceTimersByTime(NATIVE_CHAT_STEER_CHORD_HOLD_MS))
    expect(preview()).toBe('')
  })

  it('previews sending the head card after a Stop, when no turn runs to steer into', () => {
    const { props, button, hold, preview } = setup({ alternateSend: undefined })
    hold()
    expect(preview()).toBe('steer-queued')
    fireEvent.click(button)
    expect(props.steerHead).toHaveBeenCalledTimes(1)
  })
})
