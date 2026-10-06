import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'

const HOST = { foreground: '#ffffff', background: '#000000' }
const QUERY = '\x1b]11;?\x07'
const HOST_BACKGROUND_REPLY = '\x1b]11;rgb:0000/0000/0000\x1b\\'

function createHarness(intent?: PtyStartupIngressIntent) {
  const writes: string[] = []
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    ...(intent ? { intent } : {}),
    ownerBackend: 'posix-pty',
    resolveHostColors: () => HOST,
    write: (data) => writes.push(data),
    onEmission: (emission) => emissions.push(emission)
  })
  const visible = (): string => emissions.map((emission) => emission.data).join('')
  return { ingress, writes, visible }
}

describe('PTY owner colour replies for the terminal life', () => {
  afterEach(() => vi.useRealTimers())

  it('reports colours the app set itself, until it resets them', () => {
    // base16-shell / pywal set OSC 11 before the agent starts; the viewer paints that colour.
    const { ingress, writes, visible } = createHarness()

    ingress.accept('\x1b]11;#123456\x07')
    ingress.accept(QUERY)
    ingress.accept('\x1b]111\x07')
    ingress.accept(QUERY)

    expect(writes).toEqual(['\x1b]11;rgb:1212/3434/5656\x1b\\', HOST_BACKGROUND_REPLY])
    // The set and reset still reach the viewers, which paint with them.
    expect(visible()).toBe('\x1b]11;#123456\x07\x1b]111\x07')
  })

  it('answers with the viewer colours the host holds now, not the colours sent at spawn', () => {
    // The host's viewer may have changed theme since this pane was created.
    const spawnedLight = { foreground: '#2e3434', background: '#ffffff' }
    const { ingress, writes } = createHarness({ colors: spawnedLight, deadlineMs: 5_000 })

    ingress.accept(QUERY)

    expect(writes).toEqual([HOST_BACKGROUND_REPLY])
  })

  it('answers a query torn right after its ESC once the Kitty window has closed', () => {
    const { ingress, writes, visible } = createHarness({
      colors: HOST,
      kittyKeyboardProtocol: true,
      deadlineMs: 60_000
    })
    ingress.accept('\x1b[?u')
    const sgr = '\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[0m '.repeat(50)

    ingress.accept(`${sgr}out\x1b`)
    ingress.accept(']11;?\x07done')
    ingress.drainAndClose()

    expect(writes).toEqual(['\x1b[?0u', HOST_BACKGROUND_REPLY])
    expect(visible()).toBe(`${sgr}outdone`)
  })

  it('releases a torn candidate that never completes instead of withholding it forever', () => {
    vi.useFakeTimers()
    const { ingress, writes, visible } = createHarness()

    ingress.accept('prompt\x1b]1')
    expect(visible()).toBe('prompt')
    vi.advanceTimersByTime(499)
    expect(visible()).toBe('prompt')
    vi.advanceTimersByTime(1)
    expect(visible()).toBe('prompt\x1b]1')

    ingress.accept(`;title\x07${QUERY}`)
    expect(visible()).toBe('prompt\x1b]1;title\x07')
    expect(writes).toEqual([HOST_BACKGROUND_REPLY])
  })

  it('watches a reply for its echo only briefly once the startup window has closed', () => {
    vi.useFakeTimers()
    const collision = HOST_BACKGROUND_REPLY.replaceAll('\x1b', '^[')
    const printed = 'a\r\n'.repeat(200)

    const startup = createHarness()
    startup.ingress.accept(QUERY)
    startup.ingress.accept(printed)
    startup.ingress.accept(collision)
    // Inside the startup window a splash can sit between a reply and its echo.
    expect(startup.visible()).toBe(printed)

    const late = createHarness()
    vi.advanceTimersByTime(5_000)
    late.ingress.accept(QUERY)
    late.ingress.accept(collision)
    // At a cooked prompt the echo comes straight back and is still contained...
    expect(late.visible()).toBe('')
    late.ingress.accept(QUERY)
    late.ingress.accept(printed)
    late.ingress.accept(collision)
    // ...but a later match in ordinary output is no longer taken for it.
    expect(late.visible()).toBe(`${printed}${collision}`)
  })

  it("keeps the long echo watch for a viewer's relayed reply after the startup window", () => {
    // A cooked-mode app queries mid-print: the relayed reply's echo trails ~2 KB of output.
    vi.useFakeTimers()
    const reply = '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'
    const echo = reply.replaceAll('\x1b', '^[')
    const printed = 'x'.repeat(2_048)
    const { ingress, writes, visible } = createHarness()
    vi.advanceTimersByTime(5_000)

    expect(ingress.answerLiveQueryReply(reply)).toBe(true)
    ingress.accept(printed)
    ingress.accept(echo)

    expect(writes).toEqual([reply])
    expect(visible()).toBe(printed)
  })
})
