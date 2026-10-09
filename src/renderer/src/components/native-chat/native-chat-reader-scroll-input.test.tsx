// @vitest-environment happy-dom
import { fireEvent, render, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'

afterEach(cleanup)
function harness() {
  const onReaderScroll = vi.fn()
  const onLeaveEnd = vi.fn()
  let railWheel: (deltaY: number) => void = () => {}
  const view = render(<Harness />)
  function Harness() {
    const ref = useRef<HTMLDivElement>(null)
    const input = useNativeChatReaderScrollInput(ref, { onReaderScroll, onLeaveEnd })
    railWheel = input.railWheel
    return (
      <div ref={ref} data-testid="root" {...input.scrollerProps}>
        <div data-testid="nested" style={{ overflowY: 'auto' }}>
          <span data-testid="text">output</span>
        </div>
        <textarea data-testid="input" />
      </div>
    )
  }
  const root = view.getByTestId('root')
  const nested = view.getByTestId('nested')
  Object.defineProperties(root, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } })
  root.scrollTop = 1500
  Object.defineProperties(nested, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } })
  return { ...view, root, nested, onReaderScroll, onLeaveEnd, railWheel }
}
it('leaves transcript following with the nested scroller until it chains upward', () => {
  const h = harness()
  h.nested.scrollTop = 50
  fireEvent.wheel(h.getByTestId('text'), { deltaY: -10 })
  expect(h.onLeaveEnd).not.toHaveBeenCalled()
  h.nested.scrollTop = 0
  fireEvent.wheel(h.getByTestId('text'), { deltaY: -10 })
  expect(h.onLeaveEnd).toHaveBeenCalledOnce()
  h.onLeaveEnd.mockClear()
  h.nested.style.overscrollBehaviorY = 'contain'
  fireEvent.wheel(h.getByTestId('text'), { deltaY: -10 })
  expect(h.onLeaveEnd).not.toHaveBeenCalled()
})
it('hands the transcript to upward keyboard, scrollbar and rail gestures', () => {
  const h = harness()
  fireEvent.keyDown(h.root, { key: 'PageUp' })
  fireEvent.keyDown(h.root, { key: ' ', shiftKey: true })
  fireEvent.pointerDown(h.root)
  h.railWheel(-20)
  expect(h.onLeaveEnd).toHaveBeenCalledTimes(4)
})
it('hands the transcript to a touch drag only once it has carried the view off the end', () => {
  const h = harness()
  fireEvent.touchMove(h.root)
  expect(h.onLeaveEnd, 'still at the end').not.toHaveBeenCalled()
  h.root.scrollTop = 1400
  fireEvent.touchMove(h.root)
  expect(h.onLeaveEnd).toHaveBeenCalledOnce()
})
it('lets a nested scrollbar cancel a pending reveal while retaining transcript following', () => {
  const h = harness()
  h.nested.scrollTop = 50
  fireEvent.pointerDown(h.nested)
  expect(h.onReaderScroll).toHaveBeenCalledOnce()
  expect(h.onLeaveEnd).not.toHaveBeenCalled()
})
it('keeps following on downward gestures at the tail, zoom and editing keys', () => {
  const h = harness()
  fireEvent.wheel(h.root, { deltaY: 10 })
  expect(h.onLeaveEnd, 'down wheel').not.toHaveBeenCalled()
  fireEvent.keyDown(h.root, { key: 'End' })
  expect(h.onLeaveEnd, 'end key').not.toHaveBeenCalled()
  h.railWheel(20)
  expect(h.onLeaveEnd, 'down rail').not.toHaveBeenCalled()
  const zoom = new WheelEvent('wheel', { bubbles: true, deltaY: -10 })
  Object.defineProperty(zoom, 'ctrlKey', { value: true })
  fireEvent(h.root, zoom)
  expect(h.onLeaveEnd, 'zoom').not.toHaveBeenCalled()
  expect(h.getByTestId('input') instanceof HTMLElement).toBe(true)
  expect(h.getByTestId('input').closest('input, textarea, select')).not.toBeNull()
  fireEvent.keyDown(h.getByTestId('input'), { key: 'ArrowUp' })
  expect(h.onLeaveEnd, 'editable key').not.toHaveBeenCalled()
  expect(h.onLeaveEnd).not.toHaveBeenCalled()
  expect(h.onReaderScroll).toHaveBeenCalledTimes(3)
})
