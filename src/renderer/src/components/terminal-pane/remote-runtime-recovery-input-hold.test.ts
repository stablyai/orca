import { describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeRecoveryInputHold } from './remote-runtime-recovery-input-hold'
import type { PtyInputSource } from './pty-input-source'
import { observeRetainedInputWork } from './retained-input-work-test-fixture'
import {
  createPtyPreconnectInputBuffer,
  PTY_PRECONNECT_INPUT_MAX_CODE_UNITS,
  PTY_PRECONNECT_INPUT_MAX_ENTRIES
} from './pty-preconnect-input-buffer'

function createWriter() {
  const sent: string[] = []
  return {
    sent,
    writer: {
      isCurrent: () => true,
      sendInput: vi.fn((data: string) => {
        sent.push(data)
        return true
      }),
      sendInputImmediate: vi.fn(() => true),
      sendInputAccepted: vi.fn(async (data: string) => {
        sent.push(data)
        return true
      })
    }
  }
}

const endpoint = { handle: 'terminal-1', incarnationId: 'inc-1' }

describe('remote runtime recovery input hold', () => {
  it('holds more keystrokes than the per-entry cap during a long outage', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const { sent, writer } = createWriter()
    // Typing one token a second through a minutes-long outage queues one entry per keystroke.
    const keys = Array.from({ length: PTY_PRECONNECT_INPUT_MAX_ENTRIES * 2 }, (_, index) =>
      String(index % 10)
    )
    for (const key of keys) {
      expect(hold.enqueue(endpoint, key, 'driving')).toBe(true)
    }

    hold.release(endpoint, writer)
    await vi.waitFor(() => expect(hold.isHolding()).toBe(false))

    expect(sent.join('')).toBe(keys.join(''))
  })

  it('delivers held input in order to the terminal it was typed into', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const { sent, writer } = createWriter()
    expect(hold.enqueue(endpoint, 'ls', 'driving')).toBe(true)
    const accepted = hold.enqueueAccepted(endpoint, '\r', 'driving')

    hold.release(endpoint, writer)

    await expect(accepted).resolves.toBe(true)
    expect(sent).toEqual(['ls', '\r'])
    await vi.waitFor(() => expect(hold.isHolding()).toBe(false))
  })

  it('pauses a release interrupted by another outage and keeps the rest for the next release', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const { sent, writer } = createWriter()
    let current = true
    let resolvePaste = (_accepted: boolean): void => {}
    const paste = hold.enqueueAccepted(endpoint, 'paste', 'driving')
    hold.enqueue(endpoint, 'typed after', 'driving')
    hold.release(endpoint, {
      ...writer,
      isCurrent: () => current,
      sendInputAccepted: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolvePaste = resolve
          })
      )
    })
    await vi.waitFor(() => expect(hold.isHolding()).toBe(true))
    // The link drops while the paste awaits its ack; the ack arrives only after the reattach.
    current = false
    resolvePaste(true)
    await expect(paste).resolves.toBe(true)
    expect(sent).toEqual([])
    expect(hold.isHolding()).toBe(true)

    current = true
    hold.release(endpoint, writer)
    await vi.waitFor(() => expect(sent).toEqual(['typed after']))
  })

  it('keeps delivering typing after an accepted write the sequenced stream withdrew or could not confirm', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const { sent, writer } = createWriter()
    const paste = hold.enqueueAccepted(endpoint, 'paste', 'driving')
    hold.enqueue(endpoint, 'typed after', 'driving')
    hold.release(endpoint, {
      ...writer,
      sendInputAccepted: vi.fn(async () => false),
      continuesAfterFailedWrite: () => true
    })
    await expect(paste).resolves.toBe(false)
    await vi.waitFor(() => expect(sent).toEqual(['typed after']))
  })

  it('drops held input when the pane rebinds to a different terminal', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const { sent, writer } = createWriter()
    const accepted = hold.enqueueAccepted(endpoint, 'rm -rf build\r', 'driving')

    hold.release({ handle: 'terminal-2', incarnationId: null }, writer)

    await expect(accepted).resolves.toBe(false)
    expect(sent).toEqual([])
    expect(hold.isHolding()).toBe(false)
  })

  it('drops held input when the same handle reports a new incarnation', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const { sent, writer } = createWriter()
    hold.enqueue(endpoint, 'make\r', 'driving')

    hold.release({ handle: 'terminal-1', incarnationId: 'inc-2' }, writer)

    expect(sent).toEqual([])
  })

  it('accepts new input right after a release drained the previous hold', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const { sent, writer } = createWriter()
    hold.enqueue(endpoint, 'a', 'driving')
    hold.release(endpoint, writer)
    await vi.waitFor(() => expect(sent).toEqual(['a']))

    expect(hold.enqueue(endpoint, 'b', 'driving')).toBe(true)
    hold.release(endpoint, writer)
    await vi.waitFor(() => expect(sent).toEqual(['a', 'b']))
  })

  it('resolves held acknowledged input as undelivered on discard', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold()
    const accepted = hold.enqueueAccepted(endpoint, 'x', 'driving')

    hold.discard()

    await expect(accepted).resolves.toBe(false)
    expect(hold.isHolding()).toBe(false)
  })

  it('lets only the latest connect settle typing held before the pane bound a terminal', async () => {
    const hold = createRemoteRuntimeRecoveryInputHold({ holdBeforeFirstConnect: true })
    const { sent, writer } = createWriter()
    hold.enqueue(null, 'pre-entry ', 'driving')
    const superseded = hold.expect(endpoint)
    const latest = hold.expect(endpoint)
    hold.enqueue(null, 'typed', 'driving')

    hold.settleExpectation(superseded, false)
    expect(hold.isHoldingBeforeBind()).toBe(true)
    hold.settleExpectation(latest, true)
    hold.release(endpoint, writer)

    await vi.waitFor(() => expect(sent).toEqual(['pre-entry typed']))
  })
})

it('retains the entry scope through release and removes a retired accepted item without clearing its neighbors', async () => {
  const { createPtyInputSourceBinding } = await import('./pty-input-source')
  const source = createPtyInputSourceBinding<string>({
    same: (a, b) => a === b,
    refine: (_, next) => next,
    create: (get, isCurrent) => ({
      ptyId: get(),
      isCurrent,
      sendInput: () => false,
      sendInputImmediate: () => false
    })
  })
  source.change('A', () => {})
  const a = source.current()
  if (!a) {
    throw new Error('Missing A')
  }
  const hold = createRemoteRuntimeRecoveryInputHold()
  const sent: { text: string; source: unknown }[] = []
  let finish: (accepted: boolean) => void = () => {}
  const acceptedWriter = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
  )
  const accepted = hold.enqueueAccepted(endpoint, 'old-accepted', 'driving', undefined, a)
  hold.enqueue(endpoint, 'ordinary', 'driving')
  const active = hold.release(endpoint, {
    isCurrent: () => true,
    sendInput: (text, _kind, scope) => {
      sent.push({ text, source: scope })
      return true
    },
    sendInputImmediate: () => true,
    sendInputAccepted: acceptedWriter
  })
  await vi.waitFor(() => expect(acceptedWriter).toHaveBeenCalledOnce())
  expect(acceptedWriter).toHaveBeenCalledWith('old-accepted', 'driving', undefined, a)
  source.change('B', () => {})
  const b = source.current()
  if (!b) {
    throw new Error('Missing B')
  }
  hold.enqueue(endpoint, 'current-B', 'driving', b)
  finish(false)
  await active?.done
  await expect(accepted).resolves.toBe(false)
  expect(sent).toEqual([
    { text: 'ordinary', source: undefined },
    { text: 'current-B', source: b }
  ])
  expect(hold.isHolding()).toBe(false)
})

it('continues ordinary and current-scope neighbors when a synchronous held write retires its source and throws', async () => {
  const { createPtyInputSourceBinding } = await import('./pty-input-source')
  const source = createPtyInputSourceBinding<string>({
    same: (a, b) => a === b,
    refine: (_, next) => next,
    create: (get, isCurrent) => ({
      ptyId: get(),
      isCurrent,
      sendInput: () => false,
      sendInputImmediate: () => false
    })
  })
  source.change('A', () => {})
  const a = source.current()
  if (!a) {
    throw new Error('Missing A')
  }
  const hold = createRemoteRuntimeRecoveryInputHold()
  const sent: string[] = []
  hold.enqueue(endpoint, 'old-A', 'driving', a)
  hold.enqueue(endpoint, 'ordinary', 'driving')
  const release = hold.release(endpoint, {
    isCurrent: () => true,
    sendInput: (text, _kind, scope) => {
      if (scope === a) {
        source.change('B', () => {})
        const b = source.current()
        if (!b) {
          throw new Error('Missing B')
        }
        hold.enqueue(endpoint, 'current-B', 'driving', b)
        throw new Error('A retired during write')
      }
      expect(scope?.isCurrent() ?? true).toBe(true)
      sent.push(text)
      return true
    },
    sendInputImmediate: () => true,
    sendInputAccepted: async () => true
  })
  await release?.done
  expect(sent).toEqual(['ordinary', 'current-B'])
  expect(hold.isHolding()).toBe(false)
})

it.each([10, 100])(
  'bounds actual hold/preconnect bulk withdrawal and preserves mixed bytes at N=%i',
  async (n) => {
    const work = observeRetainedInputWork()
    try {
      for (const mixed of [false, true]) {
        const hold = createRemoteRuntimeRecoveryInputHold()
        let oldCurrent = true
        const old: PtyInputSource = {
          ptyId: 'old',
          isCurrent: () => oldCurrent,
          sendInput: () => true,
          sendInputImmediate: () => true
        }
        const live: PtyInputSource = { ...old, ptyId: 'live', isCurrent: () => true }
        const texts = Array.from({ length: n }, (_, i) => `v${i}💡`)
        const waits = texts.map((text, i) =>
          hold.enqueueAccepted(
            endpoint,
            text,
            'driving',
            undefined,
            mixed && i % 3 !== 0 ? (i % 3 === 1 ? old : live) : undefined
          )
        )
        oldCurrent = false
        const count = work.measure(() => hold.discardUnscoped())
        expect(count.visits).toBeGreaterThan(0)
        expect(count.reads).toBeGreaterThan(0)
        expect(count.total).toBeLessThanOrEqual(32 + 16 * n)
        const { sent, writer } = createWriter()
        await hold.release(endpoint, writer)?.done
        expect(await Promise.all(waits)).toEqual(texts.map((_, i) => mixed && i % 3 === 2))
        expect(sent).toEqual(texts.filter((_, i) => mixed && i % 3 === 2))
        expect(hold.hasPendingInput()).toBe(false)
        expect(hold.enqueue(endpoint, 'ordinary-positive', 'driving')).toBe(true)
        await hold.release(endpoint, writer)?.done
        expect(sent.at(-1)).toBe('ordinary-positive')
      }
      const buffer = createPtyPreconnectInputBuffer()
      const live: PtyInputSource = {
        ptyId: 'live',
        isCurrent: () => true,
        sendInput: () => true,
        sendInputImmediate: () => true
      }
      const waits = Array.from({ length: n }, (_, i) =>
        buffer.enqueueAccepted('💡', 'driving', undefined, undefined, i % 2 ? live : undefined)
      )
      let droppedTyping = false
      const count = work.measure(() => {
        droppedTyping = buffer.discardUnscoped()
      })
      expect(droppedTyping).toBe(true)
      expect(count.visits).toBeGreaterThan(0)
      expect(count.reads).toBeGreaterThan(0)
      expect(count.total).toBeLessThanOrEqual(32 + 16 * n)
      const remainingUnits = (n / 2) * '💡'.length
      const filler = 'z'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS - remainingUnits)
      expect(buffer.enqueue(filler, 'ordinary', 'driving')).toBe(true)
      expect(buffer.enqueue('!', 'ordinary', 'driving')).toBe(false)
      const { sent, writer } = createWriter()
      await buffer.flush(writer)
      expect(await Promise.all(waits)).toEqual(Array.from({ length: n }, (_, i) => i % 2 === 1))
      expect(sent).toEqual([...Array.from({ length: n / 2 }, () => '💡'), filler])
    } finally {
      work.dispose()
    }
  }
)

it.each(['ordinary', 'current', 'retired'] as const)(
  'ends a replaced ordinary expectation while preserving only current active scope: %s',
  async (mode) => {
    const { createPtyInputSourceBinding } = await import('./pty-input-source')
    const sources = createPtyInputSourceBinding<string>({
      same: (a, b) => a === b,
      refine: (_, next) => next,
      create: (get, isCurrent) => ({
        ptyId: get(),
        isCurrent,
        sendInput: () => false,
        sendInputImmediate: () => false
      })
    })
    sources.change('original-host-A', () => {})
    const original = sources.current()
    if (!original) {
      throw new Error('missing source')
    }
    const hold = createRemoteRuntimeRecoveryInputHold({ holdBeforeFirstConnect: true })
    const expectation = hold.expect(endpoint)
    const signal = new AbortController()
    const accepted = hold.enqueueAccepted(
      endpoint,
      'active-A',
      'driving',
      { signal: signal.signal },
      mode === 'ordinary' ? undefined : original
    )
    let finish!: (accepted: boolean) => void
    const { sent, writer } = createWriter()
    const activeWriter = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const release = hold.release(endpoint, { ...writer, sendInputAccepted: activeWriter })
    await vi.waitFor(() => expect(activeWriter).toHaveBeenCalledOnce())
    if (mode === 'retired') {
      sources.change('replacement', () => {})
    }
    hold.discardUnscoped()
    expect(hold.isHoldingBeforeBind()).toBe(false)
    expect(hold.hasPendingInput()).toBe(mode === 'current')
    if (mode !== 'current') {
      await expect(accepted).resolves.toBe(false)
    }
    const next = { handle: 'terminal-2', incarnationId: 'inc-2' }
    expect(hold.enqueue(next, 'fresh-ordinary', 'driving')).toBe(true)
    const currentRelease = hold.release(next, writer)
    // An old connect's finally must not clear the fresh current hold.
    hold.settleExpectation(expectation, false)
    if (mode === 'current') {
      expect(sent).toEqual([])
      finish(true)
      await expect(accepted).resolves.toBe(true)
    }
    await currentRelease?.done
    await release?.done
    expect(sent).toEqual(['fresh-ordinary'])
    finish(false)
    await Promise.resolve()
    expect(hold.isHolding()).toBe(false)
    expect(hold.hasPendingInput()).toBe(false)
  }
)

it.each([new Error('old abort cleanup'), null, undefined])(
  'preserves partial retirement throw %s through notice and cleanup reentry',
  async (firstFailure) => {
    const notice = vi.fn(() => {
      throw new Error('later typing notice')
    })
    const hold = createRemoteRuntimeRecoveryInputHold({
      holdBeforeFirstConnect: true,
      onTypingDiscardedBeforeBind: notice
    })
    hold.expect(endpoint)
    const firstSignal = new AbortController()
    const first = hold.enqueueAccepted(endpoint, 'old-one', 'driving', {
      signal: firstSignal.signal
    })
    const second = hold.enqueueAccepted(endpoint, 'old-two', 'driving')
    const next = { handle: 'terminal-2', incarnationId: 'inc-2' }
    let successor = hold.expect(endpoint)
    const remove = firstSignal.signal.removeEventListener.bind(firstSignal.signal)
    vi.spyOn(firstSignal.signal, 'removeEventListener').mockImplementationOnce((...args) => {
      remove(...args)
      expect(hold.isHoldingBeforeBind()).toBe(false)
      expect(hold.hasPendingInput()).toBe(false)
      successor = hold.expect(next)
      expect(hold.enqueue(next, 'fresh', 'driving')).toBe(true)
      throw firstFailure
    })
    let failed = false
    let failure: unknown
    try {
      hold.discardUnscoped()
    } catch (error) {
      failed = true
      failure = error
    }
    expect(failed).toBe(true)
    expect(failure).toBe(firstFailure)
    expect(notice).toHaveBeenCalledOnce()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    hold.settleExpectation(successor, true)
    const { sent, writer } = createWriter()
    await hold.release(next, writer)?.done
    expect(sent).toEqual(['fresh'])
    expect(hold.isHolding()).toBe(false)
  }
)

it('terminates when the last retained active scoped waiter aborts', async () => {
  const { createPtyInputSourceBinding } = await import('./pty-input-source')
  const sources = createPtyInputSourceBinding<string>({
    same: (a, b) => a === b,
    refine: (_, next) => next,
    create: (get, isCurrent) => ({
      ptyId: get(),
      isCurrent,
      sendInput: () => false,
      sendInputImmediate: () => false
    })
  })
  sources.change('A', () => {})
  const source = sources.current()
  if (!source) {
    throw new Error('missing source')
  }
  const hold = createRemoteRuntimeRecoveryInputHold({ holdBeforeFirstConnect: true })
  const controller = new AbortController()
  const accepted = hold.enqueueAccepted(
    endpoint,
    'active',
    'driving',
    { signal: controller.signal },
    source
  )
  const { writer } = createWriter()
  const send = vi.fn(() => new Promise<boolean>(() => {}))
  const release = hold.release(endpoint, { ...writer, sendInputAccepted: send })
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  hold.discardUnscoped()
  controller.abort()
  await expect(accepted).resolves.toBe(false)
  await release?.done
  expect(hold.hasPendingInput()).toBe(false)
  expect(hold.isHolding()).toBe(false)
})

it.each([null, undefined])(
  'preserves first discard throw %s through all waiter cleanup and notification reentry',
  async (firstFailure) => {
    const next = { handle: 'terminal-2', incarnationId: 'inc-2' }
    const notified = vi.fn(() => {
      expect(hold.isHolding()).toBe(false)
      hold.expect(next)
      expect(hold.enqueue(next, 'fresh', 'driving')).toBe(true)
      throw new Error('later notification')
    })
    const hold = createRemoteRuntimeRecoveryInputHold({
      holdBeforeFirstConnect: true,
      onTypingDiscardedBeforeBind: notified
    })
    const firstSignal = new AbortController()
    const secondSignal = new AbortController()
    const first = hold.enqueueAccepted(null, 'old-one', 'driving', { signal: firstSignal.signal })
    const second = hold.enqueueAccepted(null, 'old-two', 'driving', { signal: secondSignal.signal })
    const removeFirst = firstSignal.signal.removeEventListener.bind(firstSignal.signal)
    const removeSecond = secondSignal.signal.removeEventListener.bind(secondSignal.signal)
    const firstCleanup = vi
      .spyOn(firstSignal.signal, 'removeEventListener')
      .mockImplementationOnce((...args) => {
        removeFirst(...args)
        expect(hold.hasPendingInput()).toBe(false)
        throw firstFailure
      })
    const secondCleanup = vi
      .spyOn(secondSignal.signal, 'removeEventListener')
      .mockImplementationOnce((...args) => {
        removeSecond(...args)
        throw new Error('later abort cleanup')
      })
    let failed = false
    let failure: unknown
    try {
      hold.discard()
    } catch (error) {
      failed = true
      failure = error
    }
    expect(failed).toBe(true)
    expect(failure).toBe(firstFailure)
    expect(firstCleanup).toHaveBeenCalledOnce()
    expect(secondCleanup).toHaveBeenCalledOnce()
    expect(notified).toHaveBeenCalledOnce()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    const { sent, writer } = createWriter()
    await hold.release(next, writer)?.done
    expect(sent).toEqual(['fresh'])
    expect(hold.isHolding()).toBe(false)
  }
)
