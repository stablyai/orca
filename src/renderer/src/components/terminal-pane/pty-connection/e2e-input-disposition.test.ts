import { afterEach, expect, it, vi } from 'vitest'
import {
  exposeE2eTerminalPtyOutputDebug,
  recordE2eInputDisposition,
  recordE2eTransportInputDisposition
} from './e2e-terminal-pty-harness'

const config = vi.hoisted(() => ({ exposeStore: true }))
vi.mock('@/lib/e2e-config', () => ({ e2eConfig: config }))
afterEach(() => {
  vi.unstubAllGlobals()
  config.exposeStore = true
})

it('counts only the opted-in pane and releases counters on finish', () => {
  const target: {
    __terminalInputDisposition?: {
      begin: (paneId: number, ptyId?: string) => void
      finish: () => Record<string, number>
    }
  } = {}
  vi.stubGlobal('window', target)
  exposeE2eTerminalPtyOutputDebug()
  const probe = target.__terminalInputDisposition!
  recordE2eInputDisposition(1, 'sent')
  probe.begin(1, 'remote-probe')
  recordE2eTransportInputDisposition('other', 'transport-flush', 100)
  recordE2eTransportInputDisposition('remote-probe', 'transport-flush', 4)
  recordE2eTransportInputDisposition('remote-probe', 'transport-flush', 3)
  recordE2eInputDisposition(2, 'entered')
  recordE2eInputDisposition(1, 'entered')
  recordE2eInputDisposition(1, 'replay')
  expect(probe.finish()).toEqual({ entered: 1, replay: 1, 'transport-flush': 7 })
  recordE2eTransportInputDisposition('remote-probe', 'transport-flush', 1)
  recordE2eInputDisposition(1, 'sent')
  expect(probe.finish()).toEqual({})
})

it('does not expose diagnostics outside the E2E build', () => {
  config.exposeStore = false
  const target = {}
  vi.stubGlobal('window', target)
  exposeE2eTerminalPtyOutputDebug()
  recordE2eInputDisposition(1, 'entered')
  expect(target).toEqual({})
})
