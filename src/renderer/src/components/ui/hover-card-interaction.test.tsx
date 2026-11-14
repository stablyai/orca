// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('dismisses a preview on interaction and prevents a pending preview until the pointer leaves', () => {
  vi.useFakeTimers()
  render(
    <HoverCard openDelay={200}>
      <HoverCardTrigger>Target</HoverCardTrigger>
      <HoverCardContent>Preview</HoverCardContent>
    </HoverCard>
  )
  const trigger = screen.getByText('Target')
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 2 })
  act(() => vi.advanceTimersByTime(300))
  expect(screen.queryByText('Preview')).toBeNull()

  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  act(() => vi.advanceTimersByTime(300))
  expect(screen.getByText('Preview')).toBeTruthy()
  fireEvent.contextMenu(trigger)
  expect(screen.queryByText('Preview')).toBeNull()
})
