import { afterEach, expect, it, vi } from 'vitest'
import { captureMarkupBaseImage, WEBVIEW_CAPTURE_DEADLINE_MS } from './markup-base-image'

afterEach(() => vi.useRealTimers())

// An empty image settles the readback without decoding, which these cases do not need.
const emptyImage = { isEmpty: () => true }

function stallingWebview(): { webview: Electron.WebviewTag; settle: (() => void)[] } {
  const settle: (() => void)[] = []
  const webview = {
    capturePage: () =>
      new Promise((resolve) => {
        settle.push(() => resolve(emptyImage))
      })
  } as unknown as Electron.WebviewTag
  return { webview, settle }
}

it('a Draw after a stalled one waits for that readback, then captures afresh instead of failing at once', async () => {
  vi.useFakeTimers()
  const { webview, settle } = stallingWebview()
  const stalled = captureMarkupBaseImage({ kind: 'webview', webview })
  const stalledOutcome = stalled.catch((error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(WEBVIEW_CAPTURE_DEADLINE_MS)
  expect(await stalledOutcome).toBe('markup: capture failed or stalled')

  const next = captureMarkupBaseImage({ kind: 'webview', webview })
  const nextOutcome = next.catch((error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(0)
  // The stalled native readback is still running, so no second one overlaps it.
  expect(settle).toHaveLength(1)

  let nextSettled = false
  void nextOutcome.then(() => {
    nextSettled = true
  })
  await vi.advanceTimersByTimeAsync(0)
  // Not refused for the pending capture: it is still waiting.
  expect(nextSettled).toBe(false)

  settle[0]()
  await vi.advanceTimersByTimeAsync(0)
  // Its own readback started once the stalled one settled.
  expect(settle).toHaveLength(2)
  settle[1]()
  expect(await nextOutcome).toBe('markup: capture failed or stalled')
})

it('a Draw that gives up while waiting never submits a readback later', async () => {
  vi.useFakeTimers()
  const { webview, settle } = stallingWebview()
  void captureMarkupBaseImage({ kind: 'webview', webview }).catch(() => {})
  await vi.advanceTimersByTimeAsync(WEBVIEW_CAPTURE_DEADLINE_MS)
  const waiting = captureMarkupBaseImage({ kind: 'webview', webview }).catch(
    (error: Error) => error.message
  )
  await vi.advanceTimersByTimeAsync(WEBVIEW_CAPTURE_DEADLINE_MS)
  expect(await waiting).toBe('markup: capture failed or stalled')

  settle[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(settle).toHaveLength(1)
})

it('lets exactly one of two waiting Draws submit when the stalled readback settles', async () => {
  vi.useFakeTimers()
  const { webview, settle } = stallingWebview()
  void captureMarkupBaseImage({ kind: 'webview', webview }).catch(() => {})
  await vi.advanceTimersByTimeAsync(WEBVIEW_CAPTURE_DEADLINE_MS)
  const first = captureMarkupBaseImage({ kind: 'webview', webview }).catch(() => 'done')
  const second = captureMarkupBaseImage({ kind: 'webview', webview }).catch(() => 'done')
  settle[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(settle).toHaveLength(2)
  settle[1]()
  await vi.advanceTimersByTimeAsync(0)
  expect(settle).toHaveLength(3)
  settle[2]()
  expect([await first, await second]).toEqual(['done', 'done'])
})
