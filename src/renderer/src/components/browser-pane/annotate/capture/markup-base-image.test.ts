import { afterEach, expect, it, vi } from 'vitest'
import { captureMarkupBaseImage } from './markup-base-image'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Main's replies and image decodes stay pending until the test settles them. */
function stubPage() {
  const requests: { args: Record<string, unknown>; reply: (capture: unknown) => void }[] = []
  const decodes: (() => void)[] = []
  const retired: string[] = []
  const clock = { encodeMs: 0 }
  vi.stubGlobal('window', {
    api: {
      browser: {
        captureCleanPage: (args: Record<string, unknown>) =>
          new Promise((reply) => requests.push({ args, reply })),
        retireCleanCapture: async ({ attemptId }: { attemptId: string }) => {
          retired.push(attemptId)
        }
      }
    }
  })
  vi.stubGlobal(
    'Image',
    class {
      onload: () => void = () => {}
      set src(_value: string) {
        decodes.push(() => this.onload())
      }
    }
  )
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ({ fillRect: () => {}, drawImage: () => {} }),
      toDataURL: () => {
        vi.setSystemTime(Date.now() + clock.encodeMs)
        return 'data:image/png;base64,flat'
      }
    })
  })
  return { requests, decodes, retired, clock }
}

const draw = () =>
  ({
    kind: 'clean-page',
    browserPageId: 'page-1',
    guestId: 7,
    deadlineMs: Date.now() + 10_000
  }) as const
const capture = { dataUrl: 'data:image/png;base64,AA==', width: 2, height: 1 }
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

it('one absolute deadline and Draw giving up end the attempt at any step, retiring it in main', async () => {
  vi.useFakeTimers()
  const page = stubPage()

  const drawn = captureMarkupBaseImage(draw())
  expect(page.requests[0].args).toMatchObject({ guestId: 7, deadlineMs: Date.now() + 10_000 })
  page.requests[0].reply(capture)
  await flush()
  page.decodes.shift()!()
  await expect(drawn).resolves.toEqual({ ...capture, dataUrl: 'data:image/png;base64,flat' })

  const abort = new AbortController()
  const decoding = captureMarkupBaseImage(draw(), abort.signal)
  page.requests[1].reply(capture)
  await flush()
  abort.abort()
  await expect(decoding).rejects.toThrow()

  const late = captureMarkupBaseImage(draw()).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(9_000)
  page.requests[2].reply(capture)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(late).resolves.toBeInstanceOf(Error)
  expect(page.retired).toEqual([page.requests[1].args.attemptId, page.requests[2].args.attemptId])

  // A reply that lands after the deadline, before the overdue timer runs, starts no decode.
  const decodesBefore = page.decodes.length
  const overdue = captureMarkupBaseImage(draw()).catch((error: unknown) => error)
  vi.setSystemTime(Date.now() + 10_000)
  page.requests[3].reply(capture)
  await expect(overdue).resolves.toBeInstanceOf(Error)
  expect(page.decodes).toHaveLength(decodesBefore)

  // An encode that runs past the deadline (no timer can fire meanwhile) returns no image.
  page.clock.encodeMs = 10_000
  const slowEncode = captureMarkupBaseImage(draw()).catch((error: unknown) => error)
  page.requests[4].reply(capture)
  await flush()
  page.decodes.pop()!()
  await expect(slowEncode).resolves.toBeInstanceOf(Error)
})
