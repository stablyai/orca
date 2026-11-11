// Reach live v1.4.224 terminals through the old relay’s --connect after upgrade, without displacing an attached old client.
// COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SshRemotePtyLease, SshTarget } from '../../../src/shared/ssh-types'
import { SshConnection } from '../../../src/main/ssh/connection/ssh-connection'
import { toAppSshPtyId } from '../../../src/shared/ssh-pty-id'
import {
  LegacyRelayClient,
  LegacyRelayOwnerHeldError
} from '../../../src/main/ssh/legacy-relay/bridge/legacy-relay-client'
import { LegacyRelayTargetBridge } from '../../../src/main/ssh/legacy-relay/bridge/legacy-relay-target-bridge'
import { LegacyRelayPaneOwners } from '../../../src/main/ssh/legacy-relay/bridge/legacy-relay-pane-owners'
import {
  listLegacyRelayEndpoints,
  posixEndpointExited,
  type LegacyRelayEndpoint
} from '../../../src/main/ssh/legacy-relay/endpoints/legacy-relay-endpoints'
import { createLegacyRelayBridgeConnections } from '../../../src/main/ssh/legacy-relay/bridge/legacy-relay-bridge-connections'
import { waitForSentinel } from '../../../src/main/ssh/legacy-relay/handshake/ssh-relay-sentinel'
import { relaySocketNameForInstanceId } from '../../../src/main/ssh/legacy-relay/endpoints/ssh-relay-instance-id'
import { detectRemoteHostPlatform } from '../../../src/main/ssh/remote-host/ssh-remote-platform-detection'
import {
  startRealOpenSshFixture,
  type RealOpenSshFixture
} from '../../../src/main/ssh/system-transport/testing/real-openssh-sshd-fixture'
import { getRemoteHostPlatform } from '../../../src/main/ssh/remote-host/ssh-remote-platform'
import { materializeReleaseCheckout } from './release-checkout'
import {
  buildReleasedRelayBundle,
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
// Budget for the release build and its 30s owner grace.
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
          },
          owners: new LegacyRelayPaneOwners()
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
          expect(daemon.exitCode).toBeNull()
        } finally {
          bridge.dispose()
        }
      },
      SUITE_TIMEOUT_MS
    )
  }
)

// One SSH host with many old relays, each still running a shell, must stay connectable.
// The bridge holds a relay's --connect channel per endpoint; sshd's MaxSessions (default 10) caps sessions per connection.
const MANY_RELAYS_TARGET_ID = 'ssh-many-relays'
// Budget for the release build plus one real SSH session and sign-in per relay.
const MANY_RELAYS_TIMEOUT_MS = 300_000
// One per desktop update that left a relay running a shell; the reporter updated Orca many times.
const RELAY_COUNT = Number(process.env.ORCA_REPRO_RELAY_COUNT ?? 10)
// OpenSSH's default; lower values cover hosts stricter than the bridge's per-connection shard.
const MAX_SESSIONS = Number(process.env.ORCA_REPRO_MAX_SESSIONS ?? 10)

describe.skipIf(process.platform === 'win32' || process.env.ORCA_REAL_OPENSSH_TEST !== '1')(
  'an SSH host where many old relays still run a shell',
  () => {
    let fixture: RealOpenSshFixture
    const daemons: ChildProcess[] = []
    const leases: SshRemotePtyLease[] = []
    let conn: SshConnection

    beforeAll(async () => {
      fixture = await startRealOpenSshFixture({ sshd: [`MaxSessions ${MAX_SESSIONS}`] })
      const checkout = await materializeReleaseCheckout(PREVIOUS_RELAY_REF)
      const { bundleDir, version } = await buildReleasedRelayBundle(checkout)
      const sockName = relaySocketNameForInstanceId(MANY_RELAYS_TARGET_ID)
      for (let i = 0; i < RELAY_COUNT; i++) {
        const v = `${version}-${i}`
        const install: ReleasedRelayInstall = {
          dir: join(fixture.remoteHome, '.orca-remote', `relay-${v}`),
          version: v
        }
        await mkdir(install.dir, { recursive: true })
        await symlink(join(bundleDir, 'relay.js'), join(install.dir, 'relay.js'))
        await writeFile(join(install.dir, '.version'), v)
        const sockPath = join(install.dir, sockName)
        daemons.push(await startReleasedRelayDaemon(install, sockPath, { SHELL: '/bin/sh' }))
        const relayPtyId = await leaveShellInReleasedRelay(
          () => openShellRelayTransport(releasedRelayConnectCommand(install, sockPath)),
          `${v}-desktop`
        )
        leases.push({
          targetId: MANY_RELAYS_TARGET_ID,
          ptyId: relayPtyId,
          tabId: `tab-${i}`,
          leafId: `leaf-${i}`,
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        })
      }
      const sshdPort = fixture.buildOptions().resolvedConfig?.port ?? 0
      const target: SshTarget = {
        id: MANY_RELAYS_TARGET_ID,
        label: 'orca-many-relays-repro',
        host: '127.0.0.1',
        port: sshdPort,
        username: process.env.USER ?? '',
        identityFile: join(fixture.dir, 'clientkey'),
        identitiesOnly: true,
        source: 'manual'
      }
      conn = new SshConnection(target, { onStateChange: () => {} })
      await conn.connect()
    }, MANY_RELAYS_TIMEOUT_MS)

    afterAll(async () => {
      await conn?.disconnect().catch(() => {})
      for (const daemon of daemons) {
        if (daemon.exitCode === null) {
          daemon.kill('SIGKILL')
        }
      }
      await fixture?.close()
    })

    // Bridging every relay opens a real SSH session per relay, plus sign-ins for side connections.
    it(
      'still runs commands on the host while the bridge serves every old relay',
      async () => {
        // As legacy-relay-bridge-registry.ts opens relay channels.
        const channels = createLegacyRelayBridgeConnections({ primary: () => conn })
        const bridge = new LegacyRelayTargetBridge({
          targetId: MANY_RELAYS_TARGET_ID,
          leases: () => leases.filter((lease) => lease.state !== 'terminated'),
          retireLease: () => {},
          listEndpoints: (signal) => listLegacyRelayEndpoints(conn, MANY_RELAYS_TARGET_ID, signal),
          openClient: (endpoint, resume) =>
            LegacyRelayClient.open({
              clientInstanceId: `orca-legacy-relay-bridge:${MANY_RELAYS_TARGET_ID}`,
              resume,
              openTransport: async () =>
                waitForSentinel(
                  await channels.open(endpoint.connectCommand ?? '', {
                    wrapCommand: endpoint.wrapCommand
                  })
                )
            }),
          endpointExited: (endpoint) => posixEndpointExited(conn, endpoint),
          onPanesChanged: () => {},
          onData: () => {},
          onExit: () => {},
          onTerminalExited: () => {},
          owners: new LegacyRelayPaneOwners()
        })
        try {
          await bridge.refresh()
          const panes = bridge.snapshot()
          console.log(
            `[repro] relays=${RELAY_COUNT} bridged panes=${panes.length} live=${
              panes.filter((pane) => pane.state === 'live').length
            }`
          )
          // The move's first step on connect: detect the host's platform over a fresh channel.
          const probe = await detectRemoteHostPlatform(conn).then(
            (host) => `ok:${host?.relayPlatform ?? 'null'}`,
            (error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`
          )
          console.log(`[repro] platform probe -> ${probe}`)
          expect(probe).toMatch(/^ok:/)
          // Every old relay's shell is still served, none dropped to make room.
          expect(panes.filter((pane) => pane.state === 'live')).toHaveLength(RELAY_COUNT)
        } finally {
          bridge.dispose()
          channels.dispose()
        }
      },
      MANY_RELAYS_TIMEOUT_MS
    )
  }
)
