import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  parseRelayEndpointIncumbentProbe,
  relayEndpointIncumbentProbeCommand,
  type RelayEndpointIncumbent
} from '../../../src/main/ssh/ssh-relay-endpoint-incumbent'
import { mayHoldTerminals } from '../../../src/main/ssh/ssh-previous-relay-terminals'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import { accepts, PREVIOUS_RELAY_REF, runShell } from './released-relay-daemon'

/**
 * An app update leaves the previous build's relay running its terminals (#13852). This build probes
 * that relay's socket on every connect, and the old relay restarts its grace window when the probe
 * hangs up. With the `--grace-time 0` it was launched with, that window has no deadline, so the old
 * relay and its terminal must outlive the probe — and the probe must read it as holding live work.
 */
const SUITE_TIMEOUT_MS = 180_000

type Constructor = new (...args: unknown[]) => Record<string, unknown>

function isConstructor(value: unknown): value is Constructor {
  return typeof value === 'function'
}

describe.skipIf(process.platform === 'win32')(
  `a ${PREVIOUS_RELAY_REF} relay holding a live terminal, probed by this build`,
  () => {
    let dir: string
    let sockPath: string
    const graceTimeouts: number[] = []
    const dispose = vi.fn(() => new Promise<void>(() => {}))
    let incumbent: RelayEndpointIncumbent
    let stopListener: () => void = () => {}

    beforeAll(async () => {
      const checkout = await materializeReleaseCheckout(PREVIOUS_RELAY_REF)
      const [ownershipModule, listenerModule, lifecycleModule] = await Promise.all(
        [
          'src/relay/relay-socket-ownership.ts',
          'src/relay/relay-reconnect-listener.ts',
          'src/relay/relay-grace-lifecycle.ts'
        ].map((path) => importReleaseCheckoutModule(checkout, path))
      )
      const { RelaySocketOwnership } = ownershipModule
      const { RelayReconnectListener } = listenerModule
      const { RelayGraceLifecycle } = lifecycleModule
      if (
        !isConstructor(RelaySocketOwnership) ||
        !isConstructor(RelayReconnectListener) ||
        !isConstructor(RelayGraceLifecycle)
      ) {
        throw new Error(`${PREVIOUS_RELAY_REF} no longer exports the relay socket lifecycle`)
      }
      // Why /tmp: macOS's per-user tmpdir pushes a socket path past sun_path.
      dir = await mkdtemp('/tmp/orca-xv-relay-')
      sockPath = join(dir, 'relay-target.sock')
      // The daemon's PTY pool, holding the one live terminal the relay was left running.
      const ptyHandler = {
        configuredGraceTimeMs: 0,
        activePtyCount: 1,
        pendingPtyCreationCount: 0,
        graceTimerActive: false,
        startGraceTimer: (_onExpire: () => void, timeoutMs: number) => {
          graceTimeouts.push(timeoutMs)
        },
        cancelGraceTimer: () => {},
        dispose
      }
      const dispatcher = { onNotification: () => {}, onRequest: () => {} }
      const ownership = new RelaySocketOwnership(sockPath)
      let listener: Record<string, unknown> | null = null
      const lifecycle = new RelayGraceLifecycle({
        dispatcher,
        ptyHandler,
        detached: true,
        emptyDetachedStartupGraceMs: 60_000,
        idleRelayGraceMs: 60_000,
        readSocketClientCount: () => Number(listener?.clientCount ?? 0),
        hasAcceptedSocketClient: () => true,
        ownsSocketPath: () => true,
        disposeOwnedProcesses: async () => {},
        disposeRuntime: () => {}
      })
      const start = lifecycle.start
      const cancel = lifecycle.cancel
      if (typeof start !== 'function' || typeof cancel !== 'function') {
        throw new Error(`${PREVIOUS_RELAY_REF} grace lifecycle lost start/cancel`)
      }
      listener = new RelayReconnectListener(
        dispatcher,
        ownership,
        `0.1.0+${PREVIOUS_RELAY_REF}`,
        undefined,
        {
          detachPrimaryInput: () => {},
          cancelGrace: (reason: string) => cancel.call(lifecycle, reason),
          onLastClientClosed: () => start.call(lifecycle, 'socket client closed')
        }
      )
      const listen = listener.start
      if (typeof listen !== 'function') {
        throw new Error(`${PREVIOUS_RELAY_REF} reconnect listener lost start`)
      }
      await listen.call(listener)
      stopListener = () => {
        const close = ownership.closeAndCleanup
        if (typeof close === 'function') {
          close.call(ownership)
        }
      }
      start.call(lifecycle, 'socket client closed')

      incumbent = parseRelayEndpointIncumbentProbe(
        sockPath,
        await runShell(relayEndpointIncumbentProbeCommand(process.execPath, sockPath))
      )
      // Let the old relay handle the probe's hang-up.
      await new Promise((resolve) => setTimeout(resolve, 200))
    }, SUITE_TIMEOUT_MS)

    afterAll(async () => {
      stopListener()
      if (dir) {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('reads the old relay as live work this build must not replace', () => {
      expect(incumbent.verdict).toBe('live')
      expect(mayHoldTerminals(incumbent)).toBe(true)
    })

    it('leaves the old relay with no grace deadline after the probe hangs up', () => {
      expect(graceTimeouts.length).toBeGreaterThanOrEqual(2)
      expect(graceTimeouts.every((timeoutMs) => timeoutMs === 0)).toBe(true)
      expect(dispose).not.toHaveBeenCalled()
    })

    it('keeps the old relay accepting connections', async () => {
      expect(await accepts(sockPath)).toBe(true)
    })
  }
)
