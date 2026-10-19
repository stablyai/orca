/**
 * The upgrade 1.4.225 ships into: a 1.4.224 app quit with a terminal running, so its relay keeps the
 * shell alive, and that relay refuses this build's handshake. The bridge must reach the shell through
 * the old relay's own `--connect`, drive it, survive a dropped connection, never displace an
 * attached 1.4.224 client, and retire the pane once the shell exits.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SshRemotePtyLease } from '../../../src/shared/ssh-types'
import { toAppSshPtyId } from '../../../src/shared/ssh-pty-id'
import {
  LegacyRelayClient,
  LegacyRelayOwnerHeldError
} from '../../../src/main/ssh/legacy-relay/legacy-relay-client'
import { LegacyRelayTargetBridge } from '../../../src/main/ssh/legacy-relay/legacy-relay-target-bridge'
import type { LegacyRelayEndpoint } from '../../../src/main/ssh/legacy-relay/legacy-relay-endpoints'
import { getRemoteHostPlatform } from '../../../src/main/ssh/ssh-remote-platform'
import { materializeReleaseCheckout } from './release-checkout'
import {
  connectAsReleasedApp,
  installReleasedRelay,
  leaveShellInReleasedRelay,
  openShellRelayTransport,
  PREVIOUS_RELAY_REF,
  releasedRelayConnectCommand,
  startReleasedRelayDaemon,
  type ReleasedRelayInstall
} from './released-relay-daemon'

const TARGET_ID = 'ssh-upgraded'
// Why so long: building the release's relay and its 30s owner grace both count against it.
const SUITE_TIMEOUT_MS = 240_000
const OLD_APP_ID = 'v1.4.224-desktop'

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

describe.skipIf(process.platform === 'win32')(
  `terminals a ${PREVIOUS_RELAY_REF} relay kept running across the upgrade`,
  () => {
    let root: string
    let install: ReleasedRelayInstall
    let sockPath: string
    let daemon: ChildProcess
    let relayPtyId: string
    const open = (resume: LegacyRelayClient['ownerClaim'] = null): Promise<LegacyRelayClient> =>
      LegacyRelayClient.open({
        clientInstanceId: 'this-build-bridge',
        resume,
        openTransport: () => openShellRelayTransport(releasedRelayConnectCommand(install, sockPath))
      })

    beforeAll(async () => {
      const checkout = await materializeReleaseCheckout(PREVIOUS_RELAY_REF)
      // Why /tmp: macOS's per-user tmpdir pushes a socket path past sun_path.
      root = await mkdtemp('/tmp/orca-xv-bridge-')
      install = await installReleasedRelay(checkout, root)
      sockPath = join(install.dir, 'relay-target.sock')
      daemon = await startReleasedRelayDaemon(install, sockPath, { SHELL: '/bin/sh' })
      relayPtyId = await leaveShellInReleasedRelay(
        () => openShellRelayTransport(releasedRelayConnectCommand(install, sockPath)),
        `${install.version}-app`
      )
    }, SUITE_TIMEOUT_MS)

    afterAll(async () => {
      if (daemon && daemon.exitCode === null) {
        daemon.kill('SIGKILL')
      }
      if (root) {
        await rm(root, { recursive: true, force: true })
      }
    })

    it(
      'lists, attaches, types into and resizes the shell through the old relay’s own bridge',
      async () => {
        const client = await open()
        try {
          expect(client.ownerClaim).not.toBeNull()
          expect((await client.list()).map((row) => row.relayPtyId)).toContain(relayPtyId)
          let output = ''
          client.onData((id, data) => {
            if (id === relayPtyId) {
              output += data
            }
          })
          await client.attach(relayPtyId)
          client.write(relayPtyId, 'hello\n')
          await waitFor(() => output.includes('GOT:hello'), 10_000)
          client.resize(relayPtyId, 100, 30)
          client.write(relayPtyId, 'size\n')
          await waitFor(() => output.includes('30 100'), 10_000)
        } finally {
          client.close()
        }
      },
      SUITE_TIMEOUT_MS
    )

    it(
      'reattaches after a dropped connection with the screen it left, and the shell still runs',
      async () => {
        const first = await open()
        const claim = first.ownerClaim
        first.close()
        const second = await open(claim)
        try {
          const { replay } = await second.attach(relayPtyId)
          expect(replay).toContain('GOT:hello')
          let output = ''
          second.onData((_id, data) => {
            output += data
          })
          second.write(relayPtyId, 'again\n')
          await waitFor(() => output.includes('GOT:again'), 10_000)
        } finally {
          second.close()
        }
      },
      SUITE_TIMEOUT_MS
    )

    it(
      'never displaces a 1.4.224 desktop attached to its own relay, which keeps working',
      async () => {
        const oldApp = await connectAsReleasedApp(
          () => openShellRelayTransport(releasedRelayConnectCommand(install, sockPath)),
          OLD_APP_ID
        )
        try {
          await expect(open()).rejects.toBeInstanceOf(LegacyRelayOwnerHeldError)
          await oldApp.request('pty.attach', { id: relayPtyId })
          oldApp.notify('pty.data', { id: relayPtyId, data: 'old-app\n' })
          await new Promise((resolve) => setTimeout(resolve, 500))
        } finally {
          oldApp.dispose()
        }
        // The old desktop's input reached the shell, and the bridge takes over once it leaves.
        const client = await open()
        try {
          const { replay } = await client.attach(relayPtyId)
          expect(replay).toContain('GOT:old-app')
        } finally {
          client.close()
        }
      },
      SUITE_TIMEOUT_MS
    )

    it(
      'serves the leased pane until its shell exits, then retires it and hangs up',
      async () => {
        const ptyId = toAppSshPtyId(TARGET_ID, relayPtyId)
        const leases: SshRemotePtyLease[] = [
          {
            targetId: TARGET_ID,
            ptyId: relayPtyId,
            tabId: 'tab-1',
            leafId: 'leaf-1',
            state: 'detached',
            createdAt: 1,
            updatedAt: 1
          }
        ]
        const endpoint: LegacyRelayEndpoint = {
          endpoint: sockPath,
          connectCommand: releasedRelayConnectCommand(install, sockPath),
          wrapCommand: true,
          host: getRemoteHostPlatform('linux-x64'),
          nodePath: process.execPath
        }
        const data: string[] = []
        const exits: string[] = []
        let exitedTelemetry = 0
        const opened: LegacyRelayClient[] = []
        const bridge = new LegacyRelayTargetBridge({
          targetId: TARGET_ID,
          leases: () => leases.filter((lease) => lease.state !== 'terminated'),
          retireLease: (id) => {
            for (const lease of leases) {
              if (lease.ptyId === id) {
                lease.state = 'terminated'
              }
            }
          },
          listEndpoints: async () => ({ kind: 'listed', endpoints: [endpoint], exhaustive: true }),
          openClient: async (_endpoint, resume) => {
            const client = await open(resume)
            opened.push(client)
            return client
          },
          endpointExited: async () => false,
          onPanesChanged: () => {},
          onData: (_id, chunk) => data.push(chunk),
          onExit: (id) => exits.push(id),
          onTerminalExited: () => {
            exitedTelemetry += 1
          }
        })
        try {
          await bridge.refresh()
          expect(bridge.snapshot()).toEqual([
            { ptyId, targetId: TARGET_ID, tabId: 'tab-1', leafId: 'leaf-1', state: 'live' }
          ])
          await expect(bridge.attach(ptyId)).resolves.toMatchObject({ status: 'attached' })
          bridge.write(ptyId, 'bridged\n')
          await waitFor(() => data.join('').includes('GOT:bridged'), 10_000)

          bridge.write(ptyId, 'quit\n')
          await waitFor(() => exits.includes(ptyId), 10_000)
          expect(leases[0].state).toBe('terminated')
          expect(bridge.snapshot()).toEqual([])
          expect(exitedTelemetry).toBe(1)
          expect(opened.every((client) => client.closed)).toBe(true)
          // The relay itself is left alone: it keeps running on its own grace.
          expect(daemon.exitCode).toBeNull()
        } finally {
          bridge.dispose()
        }
      },
      SUITE_TIMEOUT_MS
    )
  }
)
