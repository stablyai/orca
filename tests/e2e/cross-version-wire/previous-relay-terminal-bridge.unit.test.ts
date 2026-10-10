import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toAppSshPtyId } from '../../../src/main/providers/ssh-pty-id'
import type {
  SshPtyDataCallback,
  SshPtyExitCallback
} from '../../../src/main/providers/ssh-pty-provider-contract'
import { SshChannelMultiplexer } from '../../../src/main/ssh/ssh-channel-multiplexer'
import { SshLegacyRelayRoute } from '../../../src/main/ssh/ssh-legacy-relay-route'
import { SshLegacyRelayRouter } from '../../../src/main/ssh/ssh-legacy-relay-router'
import { openSshPtyConsumerSession } from '../../../src/main/ssh/ssh-pty-consumer-session'
import { materializeReleaseCheckout } from './release-checkout'
import {
  installReleasedRelay,
  openShellRelayTransport,
  PREVIOUS_RELAY_REF,
  runShell,
  startReleasedRelayDaemon,
  type ReleasedRelayInstall
} from './released-relay-daemon'

/**
 * The upgrade this build ships into: a v1.4.218 app quit with a terminal running, so its relay keeps
 * the shell alive, and that relay refuses this build's handshake. This build must reach the shell
 * through the old relay's own bridge, resume the pane on it, and — once the shell exits — leave the
 * old relay to retire itself on its own grace.
 */
const TARGET_ID = 'ssh-upgraded'
// Why so long: the departed app's owner claim is held for its 30s grace before a new owner may take it.
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

describe.skipIf(process.platform === 'win32')(
  `a terminal a ${PREVIOUS_RELAY_REF} relay kept running across an upgrade`,
  () => {
    let root: string
    let install: ReleasedRelayInstall
    let sockPath: string
    let daemon: ChildProcess
    let daemonLog = ''
    let appPtyId: string
    const data: Parameters<SshPtyDataCallback>[0][] = []
    const exits: Parameters<SshPtyExitCallback>[0][] = []
    let router: SshLegacyRelayRouter
    let route: SshLegacyRelayRoute | null = null

    beforeAll(async () => {
      const checkout = await materializeReleaseCheckout(PREVIOUS_RELAY_REF)
      // Why /tmp: macOS's per-user tmpdir pushes a socket path past sun_path.
      root = await mkdtemp('/tmp/orca-xv-bridge-')
      install = await installReleasedRelay(checkout, root)
      sockPath = join(install.dir, 'relay-target.sock')
      daemon = await startReleasedRelayDaemon(install, sockPath, {
        SHELL: '/bin/sh',
        ORCA_RELAY_IDLE_GRACE_MS: String(IDLE_GRACE_MS)
      })
      daemon.stderr?.on('data', (chunk: Buffer) => {
        daemonLog += chunk.toString('utf-8')
      })
      const bridge = `cd '${install.dir}' && '${process.execPath}' relay.js --connect --sock-path '${sockPath}' --credential-file '${sockPath}.credential'`

      // The shipped app: owner with flow control, one shell that echoes what it reads.
      const oldApp = new SshChannelMultiplexer(await openShellRelayTransport(bridge))
      await openSshPtyConsumerSession(oldApp, {
        clientInstanceId: 'v1.4.218-app',
        expectedServerBuildId: install.version,
        outputFlowControl: { requestedWindowSu: 256 * 1024 }
      })
      const spawned: unknown = await oldApp.request('pty.spawn', { cols: 80, rows: 24 })
      if (
        !spawned ||
        typeof spawned !== 'object' ||
        !('id' in spawned) ||
        typeof spawned.id !== 'string'
      ) {
        throw new Error(`${PREVIOUS_RELAY_REF} pty.spawn returned no id`)
      }
      appPtyId = toAppSshPtyId(TARGET_ID, spawned.id)
      oldApp.notify('pty.data', {
        id: spawned.id,
        data: 'stty -echo; while read -r l; do [ "$l" = quit ] && exit 0; echo "GOT:$l"; done\n'
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      // The app quits; the relay keeps the shell.
      oldApp.dispose()

      router = new SshLegacyRelayRouter({
        targetId: TARGET_ID,
        endpoints: async () => [sockPath],
        openRoute: async (endpoint) =>
          (route = await SshLegacyRelayRoute.open({
            targetId: TARGET_ID,
            sockPath: endpoint,
            nodePath: process.execPath,
            clientInstanceId: 'this-build',
            openTransport: openShellRelayTransport,
            readText: runShell,
            sink: {
              data: (payload) => data.push(payload),
              exit: (payload) => exits.push(payload),
              replay: () => {}
            }
          }))
      })
    }, SUITE_TIMEOUT_MS)

    afterAll(async () => {
      router?.dispose()
      if (daemon && daemon.exitCode === null) {
        daemon.kill('SIGKILL')
      }
      if (root) {
        await rm(root, { recursive: true, force: true })
      }
    })

    it(
      'resumes the pane on the old relay through its own bridge',
      async () => {
        const served = await router.attach(appPtyId)
        expect(served).not.toBeNull()
        const result = await served!.provider.spawn({ sessionId: appPtyId, cols: 80, rows: 24 })
        expect(result).toMatchObject({ id: appPtyId, isReattach: true })
        expect(router.providerFor(appPtyId)).toBe(served!.provider)

        served!.provider.write(appPtyId, 'hello\n')
        await waitFor(() => data.some((payload) => payload.data.includes('GOT:hello')), 10_000)
        expect(data.every((payload) => payload.id === appPtyId)).toBe(true)
      },
      SUITE_TIMEOUT_MS
    )

    it(
      'hangs up once the shell exits and lets the old relay retire on its own grace',
      async () => {
        router.providerFor(appPtyId)!.write(appPtyId, 'quit\n')
        await waitFor(() => exits.some((exit) => exit.id === appPtyId), 10_000)
        expect(route?.serves(appPtyId)).toBe(false)
        expect(router.providerFor(appPtyId)).toBeUndefined()
        await waitFor(() => daemon.exitCode !== null, IDLE_GRACE_MS + 10_000)
        expect(daemonLog).toMatch(
          /Grace started \(socket client closed\): timeoutMs=\d+, branch=idle-no-ptys/
        )
      },
      SUITE_TIMEOUT_MS
    )
  }
)
