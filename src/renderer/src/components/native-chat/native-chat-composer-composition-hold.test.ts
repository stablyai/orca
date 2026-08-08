// @vitest-environment happy-dom

/** Unit contract for the composition hold that keeps the question-card swap
 *  from destroying a composing composer. The integration proof lives in
 *  `native-chat-question-card-composition-survival.test.tsx`; this pins the
 *  state machine on its own so a regression names the rule it broke. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useNativeChatComposerCompositionHold } from './native-chat-composer-composition-hold'

describe('native chat composer composition hold', () => {
  it('renders the composer whenever no question card is up', () => {
    const { result } = renderHook(() => useNativeChatComposerCompositionHold(false))
    expect(result.current.renderComposer).toBe(true)
  })

  it('hides the composer for a question card when nothing is composing', () => {
    const { result } = renderHook(({ active }) => useNativeChatComposerCompositionHold(active), {
      initialProps: { active: true }
    })
    expect(result.current.renderComposer).toBe(false)
  })

  it('holds the composer through a card that arrives mid-composition', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useNativeChatComposerCompositionHold(active),
      { initialProps: { active: false } }
    )

    act(() => {
      result.current.onCompositionActiveChange(true)
    })
    rerender({ active: true })
    expect(result.current.renderComposer).toBe(true)

    // The hold is owed to the composition, not to the card: it ends with the
    // composition, which browsers also end on blur.
    act(() => {
      result.current.onCompositionActiveChange(false)
    })
    expect(result.current.renderComposer).toBe(false)
  })

  it('releases the hold only when told the composition ended', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useNativeChatComposerCompositionHold(active),
      { initialProps: { active: false } }
    )

    act(() => {
      result.current.onCompositionActiveChange(true)
    })
    rerender({ active: true })
    expect(result.current.renderComposer).toBe(true)

    // The hook deliberately holds until told; nothing may guess for it, since
    // only the field knows whether its composition is still live.
    act(() => {
      result.current.onCompositionActiveChange(false)
    })
    expect(result.current.renderComposer).toBe(false)
  })
})
