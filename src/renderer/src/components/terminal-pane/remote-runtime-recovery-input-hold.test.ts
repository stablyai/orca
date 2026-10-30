import { describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeRecoveryInputHold } from './remote-runtime-recovery-input-hold'
import { PTY_PRECONNECT_INPUT_MAX_ENTRIES } from './pty-preconnect-input-buffer'

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
