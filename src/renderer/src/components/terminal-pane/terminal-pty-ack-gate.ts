import { e2eConfig } from '@/lib/e2e-config'

type E2eTerminalPtyAckGateSnapshot = {
  gatedPtyCount: number
  heldAckCount: number
  heldAckChars: number
}

type E2eTerminalPtyAckGateApi = {
  hold: (ptyIds: string[]) => void
  release: () => void
  snapshot: () => E2eTerminalPtyAckGateSnapshot
}

type E2eTerminalPtyAckGateWindow = Window & {
  __terminalPtyAckGate?: E2eTerminalPtyAckGateApi
}

const e2eTerminalAckGatePtyIds = new Set<string>()
const e2eTerminalAckGateHeldChars = new Map<string, number>()

function releaseE2eTerminalAckGate(): void {
  const held = Array.from(e2eTerminalAckGateHeldChars.entries())
  e2eTerminalAckGatePtyIds.clear()
  e2eTerminalAckGateHeldChars.clear()
  for (const [ptyId, chars] of held) {
    window.api.pty.ackData?.(ptyId, chars)
  }
}

export function exposeE2eTerminalPtyAckGate(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  // Why: perf tests need to force main-process renderer-delivery pressure
  // without changing production ACK behavior or dropping terminal output.
  const target = window as E2eTerminalPtyAckGateWindow
  target.__terminalPtyAckGate ??= {
    hold: (ptyIds) => {
      releaseE2eTerminalAckGate()
      for (const ptyId of ptyIds) {
        e2eTerminalAckGatePtyIds.add(ptyId)
      }
    },
    release: releaseE2eTerminalAckGate,
    snapshot: () => {
      let heldAckChars = 0
      for (const chars of e2eTerminalAckGateHeldChars.values()) {
        heldAckChars += chars
      }
      return {
        gatedPtyCount: e2eTerminalAckGatePtyIds.size,
        heldAckCount: e2eTerminalAckGateHeldChars.size,
        heldAckChars
      }
    }
  }
}

export function ackPtyData(ptyId: string, chars: number): void {
  if (e2eTerminalAckGatePtyIds.has(ptyId)) {
    e2eTerminalAckGateHeldChars.set(ptyId, (e2eTerminalAckGateHeldChars.get(ptyId) ?? 0) + chars)
    return
  }
  window.api.pty.ackData?.(ptyId, chars)
}
