import { describe, expect, it } from 'vitest'
import {
  AGENT_STALL_REPEAT_COOLDOWN_MS,
  createAgentStallDetector,
  toAgentStallCandidateLines
} from './agent-stall-detector'

const ESC = '\u001b'

function detectorAt(clock: { now: number }): ReturnType<typeof createAgentStallDetector> {
  return createAgentStallDetector({ now: () => clock.now })
}

describe('agent stall detector', () => {
  it('reports a network stall through SGR decoration', () => {
    const clock = { now: 1_000 }
    const detector = detectorAt(clock)

    expect(
      detector.observe(`${ESC}[31mAPI Error${ESC}[0m: ${ESC}[1mConnection error${ESC}[0m\r\n`)
    ).toEqual({ cause: 'network', signature: 'Connection error', at: 1_000 })
  })

  it('joins a failure split across PTY chunks', () => {
    const clock = { now: 5 }
    const detector = detectorAt(clock)

    expect(detector.observe('Your OAuth token has exp')).toBeNull()
    expect(detector.observe('ired. Please run /login\r\n')?.cause).toBe('auth')
  })

  it('reports a repainting TUI once, then again after the cooldown', () => {
    const clock = { now: 0 }
    const detector = detectorAt(clock)
    const frame = `${ESC}[2J${ESC}[HAPI Error: Connection error\r\n`

    expect(detector.observe(frame)).not.toBeNull()
    clock.now = AGENT_STALL_REPEAT_COOLDOWN_MS - 1
    expect(detector.observe(frame)).toBeNull()
    clock.now = AGENT_STALL_REPEAT_COOLDOWN_MS
    expect(detector.observe(frame)?.at).toBe(AGENT_STALL_REPEAT_COOLDOWN_MS)
  })

  it('reports a different cause immediately, without waiting out the cooldown', () => {
    const clock = { now: 0 }
    const detector = detectorAt(clock)

    expect(detector.observe('read ECONNRESET\r\n')?.cause).toBe('network')
    clock.now = 10
    expect(detector.observe('Invalid API key\r\n')?.cause).toBe('auth')
  })

  it('stays quiet on ordinary agent output', () => {
    const clock = { now: 0 }
    const detector = detectorAt(clock)

    expect(detector.observe('● Reading src/main/index.ts\r\n')).toBeNull()
    expect(detector.observe('  ⎿  Wrote 42 lines\r\n')).toBeNull()
    expect(detector.observe('')).toBeNull()
  })

  it('treats cursor motion as a line break but not styling', () => {
    expect(toAgentStallCandidateLines(`one${ESC}[1;1Htwo`)).toEqual(['one', 'two'])
    expect(toAgentStallCandidateLines(`one${ESC}[32mtwo`)).toEqual(['onetwo'])
  })
})
