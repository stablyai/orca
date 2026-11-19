import { expect, it, vi } from 'vitest'
import { cleanAgentSessionForkTranscript } from './agent-session-fork-context'

it('cleans repeated unterminated OSC openers with linear character reads', () => {
  const input = `start${'\u001b]'.repeat(72_000)}end`
  const original = String.prototype.charCodeAt
  let reads = 0
  const spy = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
    this: string,
    index: number
  ) {
    if (++reads > input.length * 5) {
      throw new Error('Repeated suffix scans exceeded the linear budget')
    }
    return original.call(this, index)
  })
  try {
    expect(cleanAgentSessionForkTranscript(input)).toBe('startend')
  } finally {
    spy.mockRestore()
  }
})
