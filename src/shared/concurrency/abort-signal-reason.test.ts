import { expect, it } from 'vitest'
import {
  abortSignalReason,
  isAbortSignalReason,
  waitForPromiseWithSignal
} from './abort-signal-reason'

it('recognizes a normalized cancellation reason without conflating different signals', async () => {
  const controller = new AbortController()
  controller.abort('Cancelled by caller')
  const reason = abortSignalReason(controller.signal)
  expect(isAbortSignalReason(controller.signal, reason)).toBe(true)
  await expect(waitForPromiseWithSignal(Promise.resolve(1), controller.signal)).rejects.toBe(reason)

  const other = new AbortController()
  other.abort('Cancelled by caller')
  expect(isAbortSignalReason(other.signal, reason)).toBe(false)
})
