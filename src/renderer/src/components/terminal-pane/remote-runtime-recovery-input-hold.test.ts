import { describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeRecoveryInputHold } from './remote-runtime-recovery-input-hold'

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
