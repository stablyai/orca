import { describe, expect, it } from 'vitest'
import { shouldAutofocusNativeChatComposer } from './native-chat-composer-autofocus'

describe('shouldAutofocusNativeChatComposer', () => {
  it('does not focus when the chat surface is not active (background tab/pane)', () => {
    expect(
      shouldAutofocusNativeChatComposer({
        chatSurfaceActive: false,
        composerEnabled: true,
        activeElement: null
      })
    ).toBe(false)
  })

  it('does not focus while the composer is disabled (pty not yet bound)', () => {
    expect(
      shouldAutofocusNativeChatComposer({
        chatSurfaceActive: true,
        composerEnabled: false,
        activeElement: null
      })
    ).toBe(false)
  })

  it('focuses when the surface is active, the composer is enabled, and focus is neutral', () => {
    expect(
      shouldAutofocusNativeChatComposer({
        chatSurfaceActive: true,
        composerEnabled: true,
        activeElement: null
      })
    ).toBe(true)
  })

  it('does not steal focus from a real input elsewhere (e.g. a rename field)', () => {
    const input = { tagName: 'INPUT', closest: (selector: string) => (selector ? {} : null) }

    expect(
      shouldAutofocusNativeChatComposer({
        chatSurfaceActive: true,
        composerEnabled: true,
        activeElement: input
      })
    ).toBe(false)
  })
})
