// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useContextualTourFocus } from './use-contextual-tour-focus'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
})

it('preserves active input focus when the collapse-all announcement appears and closes', () => {
  vi.useFakeTimers()
  const input = document.createElement('textarea')
  const panel = document.createElement('section')
  panel.tabIndex = -1
  const button = document.createElement('button')
  panel.append(button)
  document.body.append(input, panel)
  input.focus()
  const { rerender } = renderHook(
    ({ active }: { active: boolean }) =>
      useContextualTourFocus({
        activeTourId: active ? 'projects-collapse-all' : null,
        activeStepIndex: 0,
        rendered: active,
        panelRef: { current: panel }
      }),
    { initialProps: { active: false } }
  )
  rerender({ active: true })
  act(() => vi.runAllTimers())
  expect(document.activeElement).toBe(input)
  rerender({ active: false })
  expect(document.activeElement).toBe(input)
})
