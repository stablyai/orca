// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { syntheticGrabPayload } from '../testing/synthetic-grab-payload.fixture'
import type { BrowserGuestToolsTransport } from '../browser-guest-tools-transport'
import { useGrabMode } from './useGrabMode'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('a late absence reply for the old pick leaves the rearmed picker usable', async () => {
  const payload = syntheticGrabPayload()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { onGuestEscape: () => () => {} } }
  })
  let answerPresence: ((present: boolean | null) => void) | undefined
  let selections = 0
  const cancelled: (string | undefined)[] = []
  const transport: BrowserGuestToolsTransport = {
    setGrabMode: async () => ({ ok: true, clean: false }),
    awaitGrabSelection: ({ opId }) =>
      selections++ === 0
        ? Promise.resolve({ opId, kind: 'selected', payload })
        : new Promise(() => {}),
    grabPickedElementPresent: () =>
      new Promise<boolean | null>((resolve) => {
        answerPresence = resolve
      }),
    cancelGrab: async ({ requestId }) => {
      cancelled.push(requestId)
      return true
    },
    captureSelectionScreenshot: async () => ({ ok: false, reason: 'synthetic' }),
    extractHoverPayload: async () => ({ ok: false, reason: 'synthetic' }),
    setAnnotationViewportBridge: async () => true,
    onGrabPolicyRetired: () => () => {},
    onGrabModeToggle: () => () => {},
    onGrabActionShortcut: () => () => {}
  }
  const { result } = renderHook(() => useGrabMode('page', transport))
  act(() => result.current.toggle())
  await waitFor(() => expect(result.current.state).toBe('confirming'))
  await waitFor(() => expect(answerPresence).toBeDefined())

  await act(async () => {
    // Copy rearms; the old pick's absence reply lands before the confirming effect cleans up.
    result.current.rearm()
    answerPresence?.(false)
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
  })

  expect(cancelled).toEqual([])
  expect(result.current.state).not.toBe('idle')
})
