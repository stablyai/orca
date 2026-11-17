import { describe, expect, it } from 'vitest'
import { nativeChatMarkerRevealTarget } from './native-chat-marker-reveal'

const VIEWPORT_PX = 600

describe('the "New" marker brought into view when the window regains focus', () => {
  // A long unattended chat follows the end while the window is unfocused, so on return the first row
  // that arrived sits far above the newest rows. Revealing it scrolled the reader up into older
  // messages and stopped the transcript following the reply still streaming.
  it('leaves a reader who is at the newest rows there', () => {
    expect(
      nativeChatMarkerRevealTarget({
        markerTop: 9_600,
        rowTop: 9_590,
        scrollTop: 24_000,
        clientHeight: VIEWPORT_PX
      })
    ).toBeNull()
  })

  it('leaves the view alone once the marker has left the viewport top', () => {
    expect(
      nativeChatMarkerRevealTarget({
        markerTop: 23_988,
        rowTop: 23_988,
        scrollTop: 24_000,
        clientHeight: VIEWPORT_PX
      })
    ).toBeNull()
  })

  it('still brings a marker that arrived below the reader into view', () => {
    expect(
      nativeChatMarkerRevealTarget({
        markerTop: 24_620,
        rowTop: 24_590,
        scrollTop: 24_000,
        clientHeight: VIEWPORT_PX
      })
    ).toBe('row')
  })

  // With the marker below the viewport top but its row above it, revealing the row scrolled the
  // reader upward to the row and stopped the transcript following the reply still streaming.
  it('reveals the marker instead of a row above the viewport top', () => {
    expect(
      nativeChatMarkerRevealTarget({
        markerTop: 24_100,
        rowTop: 23_900,
        scrollTop: 24_000,
        clientHeight: VIEWPORT_PX
      })
    ).toBe('marker')
  })

  it('still reveals the row when it sits at the viewport top and meets the half-height condition', () => {
    expect(
      nativeChatMarkerRevealTarget({
        markerTop: 24_100,
        rowTop: 24_000,
        scrollTop: 24_000,
        clientHeight: VIEWPORT_PX
      })
    ).toBe('row')
  })
})
