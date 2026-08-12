/**
 * The same-turn fast path (#13892) and the ordering property that bounds it.
 *
 * A held reply is overtaken by anything written later in the same turn — fish's DA1
 * sentinel is exactly that — and the held bytes then land in the next child's stdin.
 * So a reply the kernel cannot echo must be written inside the query's own turn.
 */
import { describe, expect, it, vi } from 'vitest'
import { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import type { PtySlaveLineDisciplineEcho } from './pty-slave-line-discipline-echo'

const OSC11_REPLY = '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'
const OSC10_REPLY = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'

function createDelivery(syncState: PtySlaveLineDisciplineEcho | null): {
  delivery: PtyStartupReplyDelivery
  written: string[]
  asyncProbe: ReturnType<typeof vi.fn>
} {
  const written: string[] = []
  // Present but never resolved, so anything reaching it is visibly a deferral.
  const asyncProbe = vi.fn(() => new Promise<PtySlaveLineDisciplineEcho>(() => {}))
  const delivery = new PtyStartupReplyDelivery(
    'posix-pty',
    (data) => written.push(data),
    asyncProbe,
    syncState === null ? undefined : () => syncState
  )
  return { delivery, written, asyncProbe }
}

describe('PtyStartupReplyDelivery same-turn fast path', () => {
  it('writes inside the query turn when the kernel is provably quiet', () => {
    const { delivery, written, asyncProbe } = createDelivery('quiet')

    expect(delivery.answer(OSC11_REPLY)).toBe(true)

    expect(written).toEqual([OSC11_REPLY])
    expect(asyncProbe).not.toHaveBeenCalled()
  })

  it('still projects the software echo shapes a quiet kernel says nothing about', () => {
    const { delivery, written } = createDelivery('quiet')

    delivery.answer(OSC11_REPLY)

    // readline rewrites OSC as BEL and echoes it at a raw ECHO-off prompt (#12112), so
    // only the kernel's caret projection may retire on a `quiet` verdict.
    expect(delivery.hasExpectedEcho).toBe(true)
    expect(delivery.matchEcho(`\x07${written[0]?.slice(2, -2) ?? ''}`).kind).toBe('complete')
    expect(delivery.matchEcho(OSC11_REPLY.replaceAll('\x1b', '^[')).kind).toBe('none')
  })

  it('defers exactly as before when the probe cannot prove quiet', () => {
    for (const state of ['echoing', 'unknown', null] as const) {
      const { delivery, written } = createDelivery(state)
      expect(delivery.answer(OSC11_REPLY)).toBe(true)
      expect(written).toEqual([])
    }
  })

  it('queues behind a held reply rather than overtaking it', () => {
    const written: string[] = []
    // The tty goes raw between the two queries, which is precisely when a fast path
    // without the empty-queue guard would deliver reply #2 ahead of reply #1.
    const verdicts: PtySlaveLineDisciplineEcho[] = ['echoing', 'quiet']
    const delivery = new PtyStartupReplyDelivery(
      'posix-pty',
      (data) => written.push(data),
      undefined,
      () => verdicts.shift() ?? 'quiet'
    )

    delivery.answer(OSC11_REPLY)
    expect(written).toEqual([])
    delivery.answer(OSC10_REPLY)
    expect(written).toEqual([])

    // Both land together, in query order, when the held queue flushes.
    delivery.reset()
    expect(written).toEqual([OSC11_REPLY, OSC10_REPLY])
    delivery.close()
  })

  it('leaves ConPTY untouched: no probe is consulted and the write is immediate', () => {
    const written: string[] = []
    const syncProbe = vi.fn((): PtySlaveLineDisciplineEcho => 'quiet')
    const delivery = new PtyStartupReplyDelivery(
      'windows-conpty',
      (data) => written.push(data),
      undefined,
      syncProbe
    )

    expect(delivery.answer(OSC11_REPLY)).toBe(true)
    expect(written).toEqual([OSC11_REPLY])
    expect(syncProbe).not.toHaveBeenCalled()
  })

  it('reports failure for the reply that failed, without deferring it first', () => {
    const onFailed = vi.fn()
    const delivery = new PtyStartupReplyDelivery(
      'posix-pty',
      () => {
        throw new Error('pty gone')
      },
      undefined,
      () => 'quiet'
    )

    expect(delivery.answer(OSC11_REPLY, onFailed)).toBe(false)
    // The deferred path answers `true` and calls back later; a same-turn write knows now.
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(delivery.hasExpectedEcho).toBe(false)
  })
})
