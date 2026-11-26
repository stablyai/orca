// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { useNativeChatRailJumpLanding } from './use-native-chat-rail-jump-landing'

function slotsOf(ids: readonly string[]): NativeChatTranscriptSlot[] {
  return ids.map(
    (id) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: landing reads only a slot's kind and message id.
      ({ kind: 'message', message: { id }, turnKey: id }) as unknown as NativeChatTranscriptSlot
  )
}

/** A transcript window whose slot 1 holds an expanded tool run with a nested row numbered 3. */
function transcript(): { root: HTMLDivElement; outer: Map<number, HTMLElement> } {
  const root = document.createElement('div')
  const window = document.createElement('div')
  window.setAttribute('data-native-chat-window', '')
  root.append(window)
  const outer = new Map<number, HTMLElement>()
  for (const index of [0, 1, 2, 3, 4]) {
    const row = document.createElement('div')
    row.dataset.index = String(index)
    row.append(document.createElement('div'))
    if (index === 1) {
      const nested = document.createElement('div')
      nested.dataset.index = '3'
      nested.dataset.nestedToolRow = ''
      row.append(nested)
    }
    window.append(row)
    outer.set(index, row)
  }
  document.body.append(root)
  return { root, outer }
}

function land(slots: NativeChatTranscriptSlot[], messageId: string, root: HTMLDivElement) {
  const scrollMessageToTop = vi.fn<(element: HTMLElement) => void>()
  const onActivate = vi.fn<(id: string) => void>()
  const release = vi.fn<(request: null) => void>()
  renderHook(() =>
    useNativeChatRailJumpLanding({
      railJump: { messageId, requestId: 1 },
      slots,
      scrollRef: { current: root },
      scrollMessageToTop,
      onActivate,
      release
    })
  )
  return { scrollMessageToTop, onActivate, release }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('useNativeChatRailJumpLanding', () => {
  it("lands on the window's own slot, not an earlier tool run's nested row with that index", () => {
    const { root, outer } = transcript()
    const { scrollMessageToTop, onActivate, release } = land(
      slotsOf(['a', 'b', 'c', 'd', 'e']),
      'd',
      root
    )
    expect(scrollMessageToTop).toHaveBeenCalledOnce()
    expect(scrollMessageToTop.mock.calls[0]?.[0]).toBe(outer.get(3))
    expect(onActivate).toHaveBeenCalledWith('d')
    expect(release).toHaveBeenCalledWith(null)
  })

  it('follows the message to its new index after rows load above it', () => {
    const { root, outer } = transcript()
    const { scrollMessageToTop } = land(slotsOf(['x', 'y', 'a', 'b', 'd']), 'd', root)
    expect(scrollMessageToTop.mock.calls[0]?.[0]).toBe(outer.get(4))
  })

  it('releases a request whose message left the transcript without scrolling or lighting it', () => {
    const { root } = transcript()
    const { scrollMessageToTop, onActivate, release } = land(slotsOf(['a', 'b']), 'gone', root)
    expect(scrollMessageToTop).not.toHaveBeenCalled()
    expect(onActivate).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(null)
  })
})
