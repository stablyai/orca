// Repro: one SSH host with many old-version relays, each still running a shell, must stay connectable.
// The bridge holds a relay's --connect channel per endpoint; sshd's MaxSessions (default 10) caps channels per connection.
// COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
import type { ChildProcess } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SshRemotePtyLease, SshTarget } from '../../../src/shared/ssh-types'
import { SshConnection } from '../../../src/main/ssh/connection/ssh-connection'
import { LegacyRelayClient } from '../../../src/main/ssh/legacy-relay/legacy-relay-client'
import { LegacyRelayTargetBridge } from '../../../src/main/ssh/legacy-relay/legacy-relay-target-bridge'
import { LegacyRelayPaneOwners } from '../../../src/main/ssh/legacy-relay/legacy-relay-pane-owners'
import {
  listLegacyRelayEndpoints,
  posixEndpointExited
} from '../../../src/main/ssh/legacy-relay/legacy-relay-endpoints'
import { createLegacyRelayBridgeConnections } from '../../../src/main/ssh/legacy-relay/legacy-relay-bridge-connections'
import { waitForSentinel } from '../../../src/main/ssh/legacy-relay/ssh-relay-sentinel'
import { relaySocketNameForInstanceId } from '../../../src/main/ssh/legacy-relay/ssh-relay-instance-id'
import { detectRemoteHostPlatform } from '../../../src/main/ssh/ssh-remote-platform-detection'
import {
  startRealOpenSshFixture,
  type RealOpenSshFixture
} from '../../../src/main/ssh/system-transport/real-openssh-sshd-fixture'
import { materializeReleaseCheckout } from './release-checkout'
import {
  buildReleasedRelayBundle,
  leaveShellInReleasedRelay,
  openShellRelayTransport,
  PREVIOUS_RELAY_REF,
  releasedRelayConnectCommand,
  startReleasedRelayDaemon,
  type ReleasedRelayInstall
} from './released-relay-daemon'

const TARGET_ID = 'ssh-many-relays'
const SUITE_TIMEOUT_MS = 300_000
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
      const sockName = relaySocketNameForInstanceId(TARGET_ID)
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
          targetId: TARGET_ID,
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
        id: TARGET_ID,
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
    }, SUITE_TIMEOUT_MS)

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
          targetId: TARGET_ID,
          leases: () => leases.filter((lease) => lease.state !== 'terminated'),
          retireLease: () => {},
          listEndpoints: (signal) => listLegacyRelayEndpoints(conn, TARGET_ID, signal),
          openClient: (endpoint, resume) =>
            LegacyRelayClient.open({
              clientInstanceId: `orca-legacy-relay-bridge:${TARGET_ID}`,
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
            (host) => `ok:${host?.platform ?? 'null'}`,
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
      SUITE_TIMEOUT_MS
    )
  }
)
