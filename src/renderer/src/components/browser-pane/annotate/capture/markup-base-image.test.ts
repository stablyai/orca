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
      toDataURL: () => 'data:image/png;base64,flat'
    })
  })
  return { requests, decodes, retired }
}

const source = { kind: 'clean-page', browserPageId: 'page-1', guestId: 7 } as const
const capture = { dataUrl: 'data:image/png;base64,AA==', width: 2, height: 1 }
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

it('one absolute deadline and Draw giving up end the attempt at any step, retiring it in main', async () => {
  vi.useFakeTimers()
  const page = stubPage()

  const drawn = captureMarkupBaseImage(source)
  expect(page.requests[0].args).toMatchObject({ guestId: 7, deadlineMs: Date.now() + 10_000 })
  page.requests[0].reply(capture)
  await flush()
  page.decodes.shift()!()
  await expect(drawn).resolves.toEqual({ ...capture, dataUrl: 'data:image/png;base64,flat' })

  const abort = new AbortController()
  const decoding = captureMarkupBaseImage(source, abort.signal)
  page.requests[1].reply(capture)
  await flush()
  abort.abort()
  await expect(decoding).rejects.toThrow()

  const late = captureMarkupBaseImage(source).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(9_000)
  page.requests[2].reply(capture)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(late).resolves.toBeInstanceOf(Error)
  expect(page.retired).toEqual([page.requests[1].args.attemptId, page.requests[2].args.attemptId])
})
