import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'

const COLORS = { foreground: '#2e3434', background: '#ffffff' }
const FOREGROUND_REPLY = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
const BACKGROUND_REPLY = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'

function visible(emissions: readonly PtyIngressEmission[]): string {
  return emissions.map((emission) => emission.data).join('')
}

describe('PtyStartupIngress live OSC 10/11 answers', () => {
  afterEach(() => vi.useRealTimers())

  it('writes a live OSC 11 reply before accept returns', () => {
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('\x1b]11;?\x1b\\\x1b[6n')
    expect(writes).toEqual([BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('\x1b[6n')
    ingress.drainAndClose()
  })

  it('answers a post-startup OSC 11 query and strips it from forwarded output', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    // gh auth login writes OSC 11 (ST) plus CPR, then survey-reads stdin.
    ingress.accept('\x1b]11;?\x1b\\\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('\x1b[6n')
    ingress.accept('\x1b]11;?\x07prompt')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([BACKGROUND_REPLY, BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('\x1b[6nprompt')
    ingress.drainAndClose()
  })

  it('still answers live OSC 11 after startup query authority expires', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('\x1b]10;?\x07\x1b]11;?\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([FOREGROUND_REPLY, BACKGROUND_REPLY])
    await vi.advanceTimersByTimeAsync(5_000)
    writes.length = 0
    ingress.accept('\x1b]11;?\x1b\\')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('')
    ingress.drainAndClose()
  })

  it('answers a second OSC 11 during the startup window after that slot is claimed', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('\x1b]11;?\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([BACKGROUND_REPLY])
    writes.length = 0
    // gh auth login can query after an earlier startup OSC 11, while slot 10
    // is still open so startup authority has not handed off.
    ingress.accept('\x1b]11;?\x1b\\\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('\x1b[6n')
    ingress.drainAndClose()
  })

  it('does not strip an OSC 11 color set or other application output', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    const setAndTitle = '\x1b]11;#ffffff\x07\x1b]0;title\x07prompt'
    ingress.accept(setAndTitle)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(setAndTitle)
    ingress.drainAndClose()
  })

  it('forwards CSI-dense output without holding or answering', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    const frame = '\x1b[31mred\x1b[0m\x1b[2J\x1b[Hprompt'
    ingress.accept(frame)
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(frame)
    ingress.drainAndClose()
  })

  it('leaves Windows WSL color queries renderer-handled', () => {
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      liveOscColors: COLORS,
      ownerBackend: 'windows-wsl',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    const tornQuery = '\x1b]11;?'
    ingress.accept(tornQuery)
    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(tornQuery)
    ingress.accept('\x1b\\\x1b[6n')
    expect(visible(emissions)).toBe(`${tornQuery}\x1b\\\x1b[6n`)
    ingress.drainAndClose()
  })

  it('keeps a torn live OSC 11 held across query-authority close', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('\x1b]11;?')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([])
    expect(visible(emissions)).toBe('')
    ingress.closeQueryAuthority()
    expect(visible(emissions)).toBe('')
    ingress.accept('\x1b\\prompt')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('prompt')
    ingress.drainAndClose()
  })

  it('reassembles a fragmented OSC 11 query and still strips it', async () => {
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      liveOscColors: COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('\x1b]11;?')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([])
    expect(visible(emissions)).toBe('')
    ingress.accept('\x1b\\\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('\x1b[6n')
    ingress.drainAndClose()
  })
})
