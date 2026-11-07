import { describe, expect, it } from 'vitest'
import {
  INPUT_ECHO_DELAY_MAX_ALLOWANCE_MS,
  createTerminalInputEchoDelay,
  noteTerminalInputAwaitingEcho,
  noteTerminalOutputAfterInput,
  terminalInputEchoAllowanceMs
} from './terminal-input-echo-delay'

describe('terminal input echo delay', () => {
  it('measures the round trip from the oldest unanswered input', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalInputAwaitingEcho(delay, 1000)
    noteTerminalInputAwaitingEcho(delay, 1040)
    noteTerminalOutputAfterInput(delay, 1200)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(200)
  })

  it('stays at zero with no input, so output alone never widens the windows', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalOutputAfterInput(delay, 5000)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(0)
  })

  it('takes the recent minimum so one slow frame cannot inflate it', () => {
    const delay = createTerminalInputEchoDelay()
    for (const [input, output] of [
      [0, 210],
      [1000, 1900],
      [2000, 2205]
    ]) {
      noteTerminalInputAwaitingEcho(delay, input)
      noteTerminalOutputAfterInput(delay, output)
    }
    expect(terminalInputEchoAllowanceMs(delay)).toBe(205)
  })

  it('ignores output that cannot be the echo and clamps the allowance', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalInputAwaitingEcho(delay, 0)
    noteTerminalOutputAfterInput(delay, 5000)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(0)
    noteTerminalInputAwaitingEcho(delay, 6000)
    noteTerminalOutputAfterInput(delay, 6900)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(INPUT_ECHO_DELAY_MAX_ALLOWANCE_MS)
  })

  it('restarts a pending input that went unanswered past the sample limit', () => {
    const delay = createTerminalInputEchoDelay()
    noteTerminalInputAwaitingEcho(delay, 0)
    noteTerminalInputAwaitingEcho(delay, 3000)
    noteTerminalOutputAfterInput(delay, 3180)
    expect(terminalInputEchoAllowanceMs(delay)).toBe(180)
  })
})
