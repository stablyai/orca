import { describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeRecoveryInputHold } from './remote-runtime-recovery-input-hold'

const endpoint = { handle: 'terminal-1', incarnationId: 'inc-1' }
const other = { handle: 'terminal-2', incarnationId: 'inc-2' }

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

function holdWithNotice() {
  const onTypingDiscardedBeforeBind = vi.fn()
  const hold = createRemoteRuntimeRecoveryInputHold({
    holdBeforeFirstConnect: true,
    onTypingDiscardedBeforeBind
  })
  return { hold, onTypingDiscardedBeforeBind }
}

describe('telling the user their pre-bind typing was dropped', () => {
  it('reports keys dropped because the pane attached to a terminal they were not typed into', () => {
    const { hold, onTypingDiscardedBeforeBind } = holdWithNotice()
    hold.enqueue(null, 'ls', 'driving')

    hold.expect(null)

    expect(onTypingDiscardedBeforeBind).toHaveBeenCalledTimes(1)
    expect(hold.hasPendingInput()).toBe(false)
  })

  it('reports keys dropped when the connect that expected them never binds', () => {
    const { hold, onTypingDiscardedBeforeBind } = holdWithNotice()
    const expectation = hold.expectNewTerminal()
    hold.enqueue(null, 'git status', 'driving')

    hold.settleExpectation(expectation, false)

    expect(onTypingDiscardedBeforeBind).toHaveBeenCalledTimes(1)
  })

  it('reports keys dropped when the pane binds a different terminal than the one shown', () => {
    const { hold, onTypingDiscardedBeforeBind } = holdWithNotice()
    hold.expect(endpoint)
    hold.enqueue(endpoint, 'make', 'driving')

    hold.release(other, createWriter().writer)

    expect(onTypingDiscardedBeforeBind).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the typing reaches its terminal', async () => {
    const { hold, onTypingDiscardedBeforeBind } = holdWithNotice()
    const { sent, writer } = createWriter()
    const expectation = hold.expect(endpoint)
    hold.enqueue(endpoint, 'pwd', 'driving')
    hold.settleExpectation(expectation, true)

    hold.release(endpoint, writer)
    await vi.waitFor(() => expect(hold.isHolding()).toBe(false))

    expect(sent).toEqual(['pwd'])
    expect(onTypingDiscardedBeforeBind).not.toHaveBeenCalled()
  })

  it('stays quiet when only automatic terminal replies or nothing were dropped', () => {
    const { hold, onTypingDiscardedBeforeBind } = holdWithNotice()
    hold.expect(null)
    hold.enqueue(null, '\u001b[?1;2c', 'query-reply')
    hold.expect(null)

    expect(onTypingDiscardedBeforeBind).not.toHaveBeenCalled()
  })

  it('stays quiet when a bound terminal drops typing after an outage, which is not pre-bind', () => {
    const { hold, onTypingDiscardedBeforeBind } = holdWithNotice()
    const expectation = hold.expect(endpoint)
    hold.settleExpectation(expectation, true)
    hold.enqueue(endpoint, 'top', 'driving')

    hold.discard()

    expect(onTypingDiscardedBeforeBind).not.toHaveBeenCalled()
  })
})
