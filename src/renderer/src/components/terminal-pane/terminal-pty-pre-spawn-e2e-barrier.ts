import { e2eConfig } from '@/lib/e2e-config'

type BarrierState = {
  blocked: boolean
  release: () => void
  released: Promise<void>
  reportBlocked: () => void
  blockedReported: Promise<void>
}

export type TerminalPtyPreSpawnE2EBarrier = {
  arm: () => void
  waitUntilBlocked: () => Promise<void>
  release: () => void
  status: () => 'idle' | 'armed' | 'blocked'
}

let barrier: BarrierState | null = null

function createBarrier(): BarrierState {
  let release = (): void => {}
  let reportBlocked = (): void => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const blockedReported = new Promise<void>((resolve) => {
    reportBlocked = resolve
  })
  return { blocked: false, release, released, reportBlocked, blockedReported }
}

function exposeBarrier(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  window.__terminalPtyPreSpawnE2EBarrier ??= {
    arm: () => {
      if (barrier) {
        throw new Error('Terminal PTY pre-spawn E2E barrier is already armed')
      }
      barrier = createBarrier()
    },
    waitUntilBlocked: async () => {
      if (!barrier) {
        throw new Error('Terminal PTY pre-spawn E2E barrier is not armed')
      }
      await barrier.blockedReported
    },
    release: () => {
      barrier?.release()
    },
    status: () => (barrier ? (barrier.blocked ? 'blocked' : 'armed') : 'idle')
  }
}

export function waitAtTerminalPtyPreSpawnE2EBarrier(): Promise<void> | null {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return null
  }
  exposeBarrier()
  const current = barrier
  if (!current || current.blocked) {
    return null
  }
  current.blocked = true
  current.reportBlocked()
  return current.released.then(() => {
    if (barrier === current) {
      barrier = null
    }
  })
}
