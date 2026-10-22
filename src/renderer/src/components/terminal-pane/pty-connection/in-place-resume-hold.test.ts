import { describe, expect, it } from 'vitest'
import { isPaneResumingInPlace } from '@/lib/pane-spawn-deferral-registry'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import { holdInPlaceResumeUntilSettled } from './in-place-resume-hold'

function startupFor(paneKey: string): ColdRestoreAgentResumeStartup {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold reads only sleepingRecordEntry.paneKey.
  return { sleepingRecordEntry: { paneKey } } as ColdRestoreAgentResumeStartup
}

function isLiveUnless(disposed: boolean): () => boolean {
  return () => !disposed
}

function deferred(): { promise: Promise<unknown>; resolve: () => void; reject: () => void } {
  let resolve = (): void => {}
  let reject = (): void => {}
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res(null)
    reject = () => rej(new Error('spawn failed'))
  })
  return { promise, resolve, reject }
}

describe('holdInPlaceResumeUntilSettled', () => {
  it('owns the record while the start runs, through a nested start, and releases on settle', async () => {
    const outer = deferred()
    const inner = deferred()
    holdInPlaceResumeUntilSettled(isLiveUnless(false), startupFor('tab:a'), outer.promise)
    holdInPlaceResumeUntilSettled(isLiveUnless(false), startupFor('tab:a'), inner.promise)
    expect(isPaneResumingInPlace('tab:a')).toBe(true)
    inner.reject()
    await inner.promise.catch(() => undefined)
    expect(isPaneResumingInPlace('tab:a')).toBe(true)
    outer.resolve()
    await outer.promise
    expect(isPaneResumingInPlace('tab:a')).toBe(false)
  })

  it('holds nothing for a start not resuming a record, or once the pane is disposed', () => {
    const pending = deferred()
    holdInPlaceResumeUntilSettled(isLiveUnless(false), null, pending.promise)
    holdInPlaceResumeUntilSettled(isLiveUnless(true), startupFor('tab:b'), pending.promise)
    expect(isPaneResumingInPlace('tab:b')).toBe(false)
    pending.resolve()
  })
})
