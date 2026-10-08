import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { shutdownProviderAndDetectExit } from '../../../src/main/ipc/pty/provider/shutdown-detect'
import { verifyPtyStopped } from '../../../src/main/ipc/pty/provider/liveness'
import type { SshChannelMultiplexer as Mux } from '../../../src/main/ssh/ssh-channel-multiplexer'
import { SshPtyProvider } from '../../../src/main/providers/ssh-pty-provider'
import type { SshPtyExitCallback } from '../../../src/main/providers/ssh-pty-provider-contract'
import { SshLegacyRelayRoute } from '../../../src/main/ssh/ssh-legacy-relay-route'
import { SshLegacyRelayRouter } from '../../../src/main/ssh/ssh-legacy-relay-router'
import { materializeReleaseCheckout } from './release-checkout'
import {
  installReleasedRelay,
  leaveShellInReleasedRelay,
  openShellRelayTransport,
  PREVIOUS_RELAY_REF,
  runShell,
  startReleasedRelayDaemon,
  type ReleasedRelayInstall
} from './released-relay-daemon'

vi.mock('../../../src/main/ssh/ssh-previous-relay-terminals', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The census already found the old relay; this test drives what the client does with it.
  previousRelayMayHoldTerminals: async () => true
}))

const TARGET_ID = 'ssh-upgraded'
const SUITE_TIMEOUT_MS = 240_000
const IDLE_GRACE_MS = 1_500

function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) {
        resolve()
      } else if (Date.now() > deadline) {
        reject(new Error('timed out'))
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

/** The current relay: it never minted the old id, so attach is not-found and it lists nothing. */
function currentRelayMux(): Mux {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'pty.attach') {
      throw new Error(`PTY "${String(params?.id)}" not found`)
    }
    return method === 'pty.listProcesses' ? [] : undefined
  })
  // The provider reaches only these members of the current relay's channel here.
  return Object.assign(Object.create(null), {
    request,
    notify: vi.fn(),
    notifyWithSettlement: vi.fn(),
    onNotification: vi.fn(() => () => {}),
    onNotificationByMethod: vi.fn(() => () => {}),
    isDisposed: () => false,
    dispose: vi.fn()
  })
}

// Served: a pane resumed on the old relay this connection. Held only: no pane resumed it, as for a
// shell whose lease a respawn superseded, which Move's terminate still has to stop.
describe.skipIf(process.platform === 'win32').each([
  { scenario: 'served after a resume', resume: true },
  { scenario: 'held only, never resumed', resume: false }
])(`closing a terminal a ${PREVIOUS_RELAY_REF} relay runs, $scenario`, ({ resume }) => {
  let root: string
  let install: ReleasedRelayInstall
  let sockPath: string
  let daemon: ChildProcess
  let daemonLog = ''
  let appPtyId: string
  const exits: Parameters<SshPtyExitCallback>[0][] = []
  let provider: SshPtyProvider | undefined

  beforeAll(async () => {
    const checkout = await materializeReleaseCheckout(PREVIOUS_RELAY_REF)
    root = await mkdtemp('/tmp/orca-xv-close-')
    install = await installReleasedRelay(checkout, root)
    sockPath = join(install.dir, 'relay-target.sock')
    daemon = await startReleasedRelayDaemon(install, sockPath, {
      SHELL: '/bin/sh',
      ORCA_RELAY_IDLE_GRACE_MS: String(IDLE_GRACE_MS)
    })
    daemon.stderr?.on('data', (chunk: Buffer) => {
      daemonLog += chunk.toString('utf-8')
    })
    appPtyId = await leaveShellInReleasedRelay(install, sockPath, TARGET_ID)

    provider = connectedProvider()
    if (resume) {
      await expect(
        provider.spawn({ sessionId: appPtyId, cols: 80, rows: 24 })
      ).resolves.toMatchObject({ id: appPtyId, isReattach: true })
    }
  }, SUITE_TIMEOUT_MS)

  /** The target's provider as one connect registers it: the current relay plus legacy routing. */
  function connectedProvider(): SshPtyProvider {
    const connected = new SshPtyProvider(TARGET_ID, currentRelayMux(), undefined, 1)
    connected.setLegacyRelayRouting(
      new SshLegacyRelayRouter({
        targetId: TARGET_ID,
        endpoints: async () => [sockPath],
        openRoute: (endpoint) =>
          SshLegacyRelayRoute.open({
            targetId: TARGET_ID,
            sockPath: endpoint,
            nodePath: process.execPath,
            clientInstanceId: 'this-build',
            openTransport: openShellRelayTransport,
            readText: runShell,
            sink: { data: () => {}, exit: (payload) => exits.push(payload), replay: () => {} }
          })
      })
    )
    return connected
  }

  afterAll(async () => {
    provider?.dispose()
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGKILL')
    }
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
  })

  // What `terminal close --all` runs per PTY (stopAndWaitPtyFromRuntimeController): an immediate
  // shutdown that must observe the exit, then a fresh listing that must not list the PTY.
  it(
    'stops the old shell through the old relay and confirms its exit there',
    async () => {
      const stopping = provider!
      await expect(
        shutdownProviderAndDetectExit(stopping, appPtyId, { immediate: true })
      ).resolves.toBe(true)
      expect(exits.map((exit) => exit.id)).toContain(appPtyId)
      await expect(verifyPtyStopped(stopping, appPtyId, {})).resolves.toBe(true)
      // The old relay holds nothing now, so its own idle grace retires it.
      await waitFor(() => daemon.exitCode !== null, IDLE_GRACE_MS + 10_000)
      expect(daemonLog).toMatch(/branch=idle-no-ptys/)
    },
    SUITE_TIMEOUT_MS
  )
})
