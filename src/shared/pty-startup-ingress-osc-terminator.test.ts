// A BEL that ends the program's own OSC string is its terminator, never the head of a reply's
// readline echo, so it must not wait out the echo hold.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'

const OSC_COLOR_REPLY = '\x1b]11;rgb:0000/0000/0000\x1b\\'
const READLINE_ECHO = '\x0711;rgb:0000/0000/0000'

function harness(): { ingress: PtyStartupIngress; emissions: PtyIngressEmission[] } {
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    ownerBackend: 'posix-pty',
    write: () => {},
    onEmission: (emission) => void emissions.push(emission)
  })
  return { ingress, emissions }
}

const visible = (emissions: readonly PtyIngressEmission[]): string =>
  emissions.map((emission) => emission.data).join('')

describe('a BEL that ends an OSC string after a reply', () => {
  afterEach(() => vi.useRealTimers())

  it('passes a BEL-terminated query on at once', () => {
    vi.useFakeTimers()
    const { ingress, emissions } = harness()
    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    ingress.accept('\x1b]12;?\x07')
    expect(visible(emissions)).toBe('\x1b]12;?\x07')
    ingress.drainAndClose()
  })

  it('passes a title whose BEL ends the read, also when the title began a read earlier', () => {
    vi.useFakeTimers()
    const { ingress, emissions } = harness()
    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    ingress.accept('\x1b]0;build\x07')
    expect(visible(emissions)).toBe('\x1b]0;build\x07')
    ingress.accept('\x1b]2;long ti')
    ingress.accept('tle\x07')
    expect(visible(emissions)).toBe('\x1b]0;build\x07\x1b]2;long title\x07')
    ingress.drainAndClose()
  })

  it('passes a sixteen-colour palette read, each query answered before the next, with no hold', () => {
    vi.useFakeTimers()
    for (const terminator of ['\x07', '\x1b\\']) {
      const { ingress, emissions } = harness()
      for (let index = 0; index < 16; index += 1) {
        const query = `\x1b]4;${index};?${terminator}`
        ingress.accept(query)
        // Why no timer advance: the budget is zero hold; each query reaches the viewer in its own read.
        expect(visible(emissions).endsWith(query)).toBe(true)
        expect(ingress.answerLiveQueryReply(`\x1b]4;${index};rgb:0000/0000/0000\x1b\\`)).toBe(true)
      }
      ingress.drainAndClose()
    }
  })

  it('still holds a bare BEL, which can open the readline echo, and swallows that echo', () => {
    vi.useFakeTimers()
    const { ingress, emissions } = harness()
    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    ingress.accept('$ \x07')
    expect(visible(emissions)).toBe('$ ')
    ingress.accept(READLINE_ECHO.slice(1))
    expect(visible(emissions)).toBe('$ ')
    ingress.drainAndClose()
  })

  it('swallows a readline echo that follows a closed title', () => {
    const { ingress, emissions } = harness()
    expect(ingress.answerLiveQueryReply(OSC_COLOR_REPLY)).toBe(true)
    ingress.accept(`\x1b]0;t\x07$ ${READLINE_ECHO}`)
    expect(visible(emissions)).toBe('\x1b]0;t\x07$ ')
    ingress.drainAndClose()
  })
})
