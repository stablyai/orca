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
})
