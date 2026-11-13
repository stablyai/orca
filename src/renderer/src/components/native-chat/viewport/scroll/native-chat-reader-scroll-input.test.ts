// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'

function transcriptAtEnd(): HTMLDivElement {
  const transcript = document.createElement('div')
  Object.defineProperty(transcript, 'scrollHeight', { value: 2000 })
  Object.defineProperty(transcript, 'clientHeight', { value: 500 })
  transcript.scrollTop = 1500
  return transcript
}

function renderReaderInput(transcript: HTMLDivElement) {
  const onLeaveEnd = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatReaderScrollInput(
      { current: transcript },
      { onReaderScroll: vi.fn(), onLeaveEnd, onScrollGesture: vi.fn() }
    )
  )
  return { scrollBy: result.current.scrollBy, onLeaveEnd }
}

it('stops following the latest when an outside scroll moves a transcript up from its end', () => {
  const transcript = transcriptAtEnd()
  const { scrollBy, onLeaveEnd } = renderReaderInput(transcript)

  expect(scrollBy(-300)).toBe(true)

  expect(transcript.scrollTop).toBe(1200)
  expect(onLeaveEnd).toHaveBeenCalledTimes(1)
})

it('reports nothing moved when an outside scroll pushes past the end', () => {
  const transcript = transcriptAtEnd()
  const { scrollBy, onLeaveEnd } = renderReaderInput(transcript)

  expect(scrollBy(300)).toBe(false)

  expect(transcript.scrollTop).toBe(1500)
  expect(onLeaveEnd).not.toHaveBeenCalled()
})
