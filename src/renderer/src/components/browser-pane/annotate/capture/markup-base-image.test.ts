import { afterEach, expect, it, vi } from 'vitest'
import { captureMarkupBaseImage } from './markup-base-image'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('a clean capture Draw gives up on, by abort or by its deadline, retires that same attempt in main', async () => {
  vi.useFakeTimers()
  const sent: string[] = []
  const retired: string[] = []
  vi.stubGlobal('window', {
    api: {
      browser: {
        captureCleanPage: ({ attemptId }: { attemptId: string }) => {
          sent.push(attemptId)
          return new Promise(() => {})
        },
        retireCleanCapture: async ({ attemptId }: { attemptId: string }) => {
          retired.push(attemptId)
        }
      }
    }
  })
  const source = { kind: 'clean-page', browserPageId: 'page-1' } as const

  const abort = new AbortController()
  const aborted = captureMarkupBaseImage(source, abort.signal).catch(() => 'failed')
  abort.abort()
  expect(retired).toEqual([sent[0]])

  const late = captureMarkupBaseImage(source).catch(() => 'failed')
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(late).resolves.toBe('failed')
  expect(retired).toEqual([sent[0], sent[1]])
  expect(new Set(sent).size).toBe(2)
  void aborted
})
