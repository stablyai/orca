import { describe, expect, it } from 'vitest'
import { nativeChatToolRunOutcome } from './native-chat-tool-run-outcome'
import type { NativeChatBlock } from './native-chat-types'

function call(command: string, state?: 'running' | 'completed' | 'failed'): NativeChatBlock {
  return { type: 'tool-call', name: 'shell', input: { command }, state }
}

function result(output: string, isError?: boolean): NativeChatBlock {
  return { type: 'tool-result', output, isError }
}

describe('nativeChatToolRunOutcome', () => {
  it('counts a provider failure verdict', () => {
    expect(nativeChatToolRunOutcome([call('a', 'failed'), result('exit 1', true)], {})).toEqual({
      failedCallCount: 1,
      succeeded: false
    })
  })

  it('counts an error result on a lane that writes no lifecycle state', () => {
    expect(nativeChatToolRunOutcome([call('a'), result('exit 1', true)], {})).toEqual({
      failedCallCount: 1,
      succeeded: false
    })
  })

  it('counts every failure, not just the run’s last call', () => {
    expect(
      nativeChatToolRunOutcome(
        [
          call('a', 'failed'),
          result('exit 1', true),
          call('b', 'failed'),
          result('exit 2', true),
          call('c', 'completed'),
          result('ok')
        ],
        {}
      ).failedCallCount
    ).toBe(2)
  })

  it('counts a failed call once, not twice for its error result', () => {
    expect(
      nativeChatToolRunOutcome([call('a', 'failed'), result('exit 1', true)], {}).failedCallCount
    ).toBe(1)
  })

  it('does not misattribute a later error to an outputless completed call', () => {
    expect(
      nativeChatToolRunOutcome(
        [call('a', 'completed'), call('b', 'failed'), result('exit 1', true)],
        {}
      ).failedCallCount
    ).toBe(1)
  })

  it('reports nothing for a clean run', () => {
    expect(
      nativeChatToolRunOutcome([call('a', 'completed'), result('ok')], {}).failedCallCount
    ).toBe(0)
  })

  it('refuses success to a failed run even though nothing is running', () => {
    expect(
      nativeChatToolRunOutcome([call('a', 'failed'), result('exit 1', true)], {}).succeeded
    ).toBe(false)
  })

  it('refuses success to a run whose call is still running', () => {
    expect(
      nativeChatToolRunOutcome([call('a', 'running')], { activeTurnIsWorking: true }).succeeded
    ).toBe(false)
  })

  it('refuses success to a call still running after its turn ended', () => {
    expect(
      nativeChatToolRunOutcome([call('a', 'running')], { activeTurnIsWorking: false }).succeeded
    ).toBe(false)
  })

  it('refuses success while a state-less call rides a working turn', () => {
    expect(nativeChatToolRunOutcome([call('a')], { activeTurnIsWorking: true }).succeeded).toBe(
      false
    )
  })

  it('grants success to a completed run', () => {
    expect(nativeChatToolRunOutcome([call('a', 'completed'), result('ok')], {}).succeeded).toBe(
      true
    )
  })

  it('still settles a legacy run that carries no lifecycle state', () => {
    expect(nativeChatToolRunOutcome([call('a'), result('ok')], {}).succeeded).toBe(true)
  })

  it('refuses success when one call of several failed', () => {
    expect(
      nativeChatToolRunOutcome(
        [call('a', 'completed'), result('ok'), call('b', 'failed'), result('exit 1', true)],
        {}
      ).succeeded
    ).toBe(false)
  })
})
