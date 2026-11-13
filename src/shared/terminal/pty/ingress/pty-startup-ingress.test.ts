import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress } from './pty-startup-ingress'

import type { PtyIngressEmission } from './pty-startup-ingress-contract'

const COLORS = { foreground: '#2e3434', background: '#ffffff' }
const FOREGROUND_REPLY = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'

// The two echo shapes a cooked POSIX tty produces for a written reply: ECHOCTL
// caret forms, and readline eating `ESC ]` / ST while self-inserting the rest.
const POSIX_COOKED_ECHOES = [
  (reply: string): string => reply.replaceAll('\x1b', '^['),
  (reply: string): string => reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
]

function createHarness(
  options: {
    projection?: boolean
    nested?: (data: string) => void
  } = {}
) {
  const emissions: PtyIngressEmission[] = []
  let ingress!: PtyStartupIngress
  const writes: string[] = []
  ingress = new PtyStartupIngress({
    intent: {
      colors: COLORS,
      deadlineMs: 5_000
    },
    ...(options.projection ? { ownerBackend: 'windows-conpty' as const } : {}),
    write: (data) => {
      writes.push(data)
      options.nested?.(data)
    },
    onEmission: (emission) => emissions.push(emission)
  })
  return { ingress, writes, emissions }
}

function visible(emissions: readonly PtyIngressEmission[]): string {
  return emissions.map((emission) => emission.data).join('')
}

describe('PtyStartupIngress', () => {
  afterEach(() => vi.useRealTimers())

  it('swallows a cooked POSIX echo of its own reply without re-sending it', () => {
    // Kernel echo leaves the original reply in slave input; resending would become unsolicited stdin after raw mode starts.
    vi.useFakeTimers()
    for (const echoOf of POSIX_COOKED_ECHOES) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      let ingress!: PtyStartupIngress
      ingress = new PtyStartupIngress({
        intent: { colors: COLORS, deadlineMs: 5_000 },
        ownerBackend: 'posix-pty',
        write: (data) => {
          writes.push(data)
          ingress.accept(echoOf(data))
        },
        onEmission: (emission) => emissions.push(emission)
      })

      ingress.accept('\x1b]10;?\x07')
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([FOREGROUND_REPLY])
      expect(visible(emissions)).toBe('')

      vi.advanceTimersByTime(5_000)
      expect(writes).toEqual([FOREGROUND_REPLY])
      expect(visible(emissions)).toBe('')
      ingress.drainAndClose()
    }
  })

  it('keeps raw ranges disjoint when an echo lands on a retained torn query', () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    ingress.accept('\x1b]10;?\x07\x1b]11;?')
    vi.advanceTimersByTime(0)
    ingress.accept(`${writes[0]?.replaceAll('\x1b', '^[')}tail`)
    const accepted = ingress.drainAndClose()

    expect(visible(emissions)).toBe('\x1b]11;?tail')
    // Crossing suppressed ranges with a retained candidate corrupts sequence arithmetic and overlaps output ranges.
    expect(emissions.map((item) => [item.rawStartSeq, item.rawEndSeq])).toEqual([
      [0, 7],
      [7, 13],
      [13, 40],
      [40, accepted]
    ])
  })
})
