/** Echo fixtures captured from live bash PTYs: raw readline software echoes and cooked read/kernel ECHOCTL.
 * Old guesses missed BEL→^G and private-DSR readline projections; keep recorded bytes independent of the implementation. */
import { describe, expect, it } from 'vitest'
import { locateEcho, replyEchoProjections } from './pty-startup-reply-echo-shapes'

const OSC11_BEL = '\x1b]11;rgb:2e2e/3434/3434\x07'
const OSC11_ST = '\x1b]11;rgb:2e2e/3434/3434\x1b\\'
const OSC10_BEL = '\x1b]10;rgb:c6c6/c6c6/c6c6\x07'
const DSR_997 = '\x1b[?997;1n'
const DSR_996 = '\x1b[?996n'

/** `readline` = tty raw at a bash prompt; `cooked` = kernel ECHOCTL under `read`. */
const LIVE_ECHOES: readonly { name: string; reply: string; echo: string }[] = [
  { name: 'OSC 11 BEL / readline', reply: OSC11_BEL, echo: '\x0711;rgb:2e2e/3434/3434\x07' },
  { name: 'OSC 11 ST / readline', reply: OSC11_ST, echo: '\x0711;rgb:2e2e/3434/3434' },
  { name: 'OSC 10 BEL / readline', reply: OSC10_BEL, echo: '\x0710;rgb:c6c6/c6c6/c6c6\x07' },
  { name: 'DSR 997 / readline', reply: DSR_997, echo: '\x07997;1n' },
  { name: 'DSR 996 / readline', reply: DSR_996, echo: '\x07996n' },
  { name: 'OSC 11 BEL / cooked', reply: OSC11_BEL, echo: '^[]11;rgb:2e2e/3434/3434^G' },
  { name: 'OSC 11 ST / cooked', reply: OSC11_ST, echo: '^[]11;rgb:2e2e/3434/3434^[\\' },
  { name: 'OSC 10 BEL / cooked', reply: OSC10_BEL, echo: '^[]10;rgb:c6c6/c6c6/c6c6^G' },
  { name: 'DSR 997 / cooked', reply: DSR_997, echo: '^[[?997;1n' },
  { name: 'DSR 996 / cooked', reply: DSR_996, echo: '^[[?996n' }
]

describe('replyEchoProjections on a POSIX pty', () => {
  it.each(LIVE_ECHOES)('matches the live $name echo', ({ reply, echo }) => {
    const match = locateEcho(replyEchoProjections(reply, 'posix-pty'), echo)
    expect(match).toEqual({ kind: 'complete', offset: 0, length: echo.length })
  })

  // Coalesced echo follows shell output, so offset-zero anchors miss real cases.
  it.each(LIVE_ECHOES)('finds the $name echo embedded in output', ({ reply, echo }) => {
    const match = locateEcho(replyEchoProjections(reply, 'posix-pty'), `user@host:~$ ${echo} `)
    expect(match).toEqual({ kind: 'complete', offset: 13, length: echo.length })
  })

  // `stty -echoctl` echoes the reply verbatim.
  it.each(LIVE_ECHOES.map((entry) => entry.reply))('matches the verbatim echo of %j', (reply) => {
    expect(locateEcho(replyEchoProjections(reply, 'posix-pty'), reply).kind).toBe('complete')
  })
})
