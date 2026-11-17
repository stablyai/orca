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
})
