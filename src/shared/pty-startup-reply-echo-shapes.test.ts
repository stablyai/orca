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

  it('caret-encodes every control, not just ESC', () => {
    const [kernel] = replyEchoProjections(OSC11_BEL, 'posix-pty')
    expect(kernel?.needle).toBe('^[]11;rgb:2e2e/3434/3434^G')
    expect(kernel?.needle).not.toContain('\x07')
  })

  // ECHOCTL leaves TAB/LF/CR literal and maps DEL→^? (vis(3)); pin future grammar behavior even though current replies lack them.
  it.each([
    { name: 'TAB stays literal', input: '\t', encoded: '\t' },
    { name: 'LF stays literal', input: '\n', encoded: '\n' },
    { name: 'CR stays literal', input: '\r', encoded: '\r' },
    { name: 'NUL carets to ^@', input: '\x00', encoded: '^@' },
    { name: 'BEL carets to ^G', input: '\x07', encoded: '^G' },
    { name: 'ESC carets to ^[', input: '\x1b', encoded: '^[' },
    { name: 'DEL carets to ^?', input: '\x7f', encoded: '^?' }
  ])('$name under ECHOCTL', ({ input, encoded }) => {
    const [kernel] = replyEchoProjections(`\x1b[?9${input}n`, 'posix-pty')
    expect(kernel?.needle).toBe(`^[[?9${encoded}n`)
  })

  // Guard the private-DSR grammar locally: widening a caller must not arm DA1’s shared-prefix BEL needle.
  it.each(['\x1b[?1;2c', '\x1b[?0u', '\x1b[?2026;2$y', '\x1b[?12;5R'])(
    'projects no readline needle for %j, which is not a private DSR',
    (reply) => {
      const needles = replyEchoProjections(reply, 'posix-pty').map(
        (projection) => projection.needle
      )
      expect(needles.some((needle) => needle.startsWith('\x07'))).toBe(false)
    }
  )

  // Peer-supplied empty/short DSR parameters could otherwise arm BEL+n and delete ordinary output.
  it.each(['\x1b[?n', '\x1b[?;n', '\x1b[?5n'])(
    'projects no readline needle for %j, which would be too short to be safe',
    (reply) => {
      const needles = replyEchoProjections(reply, 'posix-pty').map(
        (projection) => projection.needle
      )
      expect(needles.some((needle) => needle.startsWith('\x07'))).toBe(false)
    }
  )

  it('projects readline for a private DSR, which carries no OSC introducer', () => {
    const needles = replyEchoProjections(DSR_997, 'posix-pty').map(
      (projection) => projection.needle
    )
    expect(needles).toContain('\x07997;1n')
  })

  // Never hold ESC-led partials: a bare ESC could belong to a torn query and would escape unanswered when the hold expires.
  it('holds a partial only for needles that do not start with ESC', () => {
    for (const { reply } of LIVE_ECHOES) {
      for (const projection of replyEchoProjections(reply, 'posix-pty')) {
        expect(projection.holdPartial).toBe(!projection.needle.startsWith('\x1b'))
      }
    }
  })
})

describe('replyEchoProjections on other backends', () => {
  it('keeps ConPTY on its documented ESC-stripped form', () => {
    expect(replyEchoProjections(DSR_997, 'windows-conpty')).toEqual([
      { needle: '[?997;1n', holdPartial: true }
    ])
  })

  // ConPTY BEL echo is unmeasured; preserve current raw-BEL needle rather than guessing. In-tree OSC replies all use ST.
  it('leaves a BEL literal in the ConPTY needle, which is unverified', () => {
    const [conpty] = replyEchoProjections(OSC11_BEL, 'windows-conpty')
    expect(conpty?.needle).toBe(']11;rgb:2e2e/3434/3434\x07')
    // The ST reply is the shape #9651 was actually reported against, and it has no BEL.
    const [st] = replyEchoProjections(OSC11_ST, 'windows-conpty')
    expect(st?.needle).toBe(']11;rgb:2e2e/3434/3434\\')
  })

  it('suppresses nothing when the echo shape is unverified', () => {
    expect(replyEchoProjections(DSR_997, 'windows-wsl')).toEqual([])
  })
})
