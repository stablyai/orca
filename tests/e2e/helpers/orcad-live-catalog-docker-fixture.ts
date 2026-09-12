import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { SshConnectionManager } from '../../../src/main/ssh/ssh-connection-manager'
import { SshChannelMultiplexer } from '../../../src/main/ssh/ssh-channel-multiplexer'
import { OrcadManagedTunnelManager } from '../../../src/main/ssh/orcad-managed-tunnel'
import type { SshConnectionStore } from '../../../src/main/ssh/ssh-connection-store'
import { initSshHostKeyStoreFile } from '../../../src/main/ssh/ssh-host-key-store'
import { execCommand, waitForSentinel } from '../../../src/main/ssh/ssh-relay-deploy-helpers'
import type { SshTarget } from '../../../src/shared/ssh-types'
import {
  startDockerSshRelayTarget,
  cleanupDockerSshRelayTarget,
  copyFileIntoDockerSshRelayTarget,
  shellQuote as q
} from './docker-ssh-relay-target'
import { createLiveCatalogSshDestination } from './orcad-live-catalog-ssh-destination'

export async function createLiveCatalogDockerFixture(options: {
  relayArtifactDir: string
  orcadArtifactDir: string
  disconnectAfterMigration?: boolean
  sourceOwner?: 'fixture' | 'desktop'
}) {
  const desktopDirectory = mkdtempSync(join(tmpdir(), 'orca-live-catalog-desktop-'))
  let target: ReturnType<typeof startDockerSshRelayTarget>
  try {
    target = startDockerSshRelayTarget({ workerIndex: 0 } as TestInfo)
  } catch (error) {
    rmSync(desktopDirectory, { recursive: true, force: true })
    throw error
  }
  const directory = '/tmp/orca-live-catalog'
  const environmentId = 'live-catalog-destination'
  const managedTarget: SshTarget = {
    id: environmentId,
    label: 'Disposable live catalog SSH host',
    source: 'manual',
    host: target.host,
    port: target.port,
    username: 'root',
    identityFile: target.identityFile,
    identitiesOnly: true,
    generation: 1,
    owner: { type: 'orcad-runtime', environmentId }
  }
  initSshHostKeyStoreFile(join(desktopDirectory, 'data.json'))
  const manager = new SshConnectionManager({ onStateChange: () => {} })
  const tunnels = new OrcadManagedTunnelManager({
    getConnectionManager: () => manager,
    getTargetStore: () =>
      ({
        getTarget: (id: string) => (id === managedTarget.id ? managedTarget : undefined)
      }) as SshConnectionStore
  })
  let mux: SshChannelMultiplexer | undefined
  let disposal: Promise<void> | undefined
  const dispose = () =>
    (disposal ??= (async () => {
      const failures: unknown[] = []
      try {
        mux?.dispose('shutdown')
      } catch (error) {
        failures.push(error)
      }
      try {
        await tunnels.close(environmentId)
        tunnels.dispose()
      } catch (error) {
        failures.push(error)
      }
      try {
        await manager.disconnectAll()
      } catch (error) {
        failures.push(error)
      }
      // The entire container is fixture-owned; no desktop application or user daemon is reachable.
      try {
        cleanupDockerSshRelayTarget(target)
      } catch (error) {
        failures.push(error)
      }
      rmSync(desktopDirectory, { recursive: true, force: true })
      if (failures.length) {
        throw new AggregateError(failures, 'fixture_live_catalog_cleanup_failed')
      }
    })())
  try {
    const connection = await manager.connect(managedTarget)
    const execute = (command: string) => execCommand(connection, command, { timeoutMs: 30_000 })
    const nodeProbe = await execute(
      'for runtime in node nodejs npm npx; do if command -v "$runtime" >/dev/null 2>&1; then exit 1; fi; done; printf NO_HOST_NODE'
    )
    if (nodeProbe !== 'NO_HOST_NODE') {
      throw new Error('fixture_host_node_probe_failed')
    }
    await execute(`mkdir -p ${q(directory)}`)
    copyFileIntoDockerSshRelayTarget(target, options.relayArtifactDir, `${directory}/relay`)
    copyFileIntoDockerSshRelayTarget(target, options.orcadArtifactDir, `${directory}/orcad`)
    const bun = `${directory}/orcad/bun-runtime`
    const version = (await execute(`${q(bun)} --version`)).trim()
    const [major, minor] = version.split('.').map(Number)
    if (!(major > 1 || (major === 1 && minor >= 4))) {
      throw new Error(`fixture_bun_version_unsupported: ${version}`)
    }
    const seedPaths = {
      repoPath: `${directory}/repo`,
      worktreePath: `${directory}/worktree`,
      folderPath: `${directory}/folder`
    }
    await execute(
      [
        `mkdir -p ${q(seedPaths.folderPath)} ${q(`${directory}/source-home`)}`,
        `git init ${q(seedPaths.repoPath)}`,
        `git -C ${q(seedPaths.repoPath)} -c user.name=Fixture -c user.email=fixture@localhost commit --allow-empty -m fixture`,
        `git -C ${q(seedPaths.repoPath)} worktree add -b fixture-worktree ${q(seedPaths.worktreePath)}`
      ].join(' && ')
    )
    if (options.sourceOwner !== 'desktop') {
      const relayEntry = `${directory}/relay/relay.js`
      const endpoint = `${directory}/relay.sock`
      const credentialFile = `${directory}/credential`
      await execute(
        `nohup env HOME=${q(`${directory}/source-home`)} ORCA_BACKGROUND_LAUNCH=1 ORCA_TEST_MOCK_KEYCHAIN=1 ${q(bun)} ${q(relayEntry)} --detached --grace-time 0 --sock-path ${q(endpoint)} --endpoint-dir ${q(`${directory}/hooks`)} --credential-file ${q(credentialFile)} --enable-ownership-transfer-mutation --enable-delegated-ownership-capture --enable-source-delivery-retirement > ${q(`${directory}/relay.log`)} 2>&1 < /dev/null &`
      )
      const deadline = Date.now() + 30_000
      let ready = false
      while (Date.now() < deadline) {
        ready = (await execute(`[ -s ${q(credentialFile)} ] && printf ready || true`)) === 'ready'
        if (ready) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!ready) {
        throw new Error(
          `fixture_relay_not_ready: ${await execute(`tail -c 32768 ${q(`${directory}/relay.log`)}`)}`
        )
      }
      const channel = await connection.exec(
        `exec ${q(bun)} ${q(relayEntry)} --connect --sock-path ${q(endpoint)} --credential-file ${q(credentialFile)}`
      )
      mux = new SshChannelMultiplexer(await waitForSentinel(channel))
    }
    const remotePort = 6768
    const localPort = await tunnels.start(environmentId, managedTarget, connection, remotePort)
    const destination = createLiveCatalogSshDestination({
      connection,
      directory: `${directory}/destination`,
      artifactDirectory: `${directory}/orcad`,
      remotePort,
      localPort
    })
    return {
      directory: desktopDirectory,
      sourceDirectory: directory,
      connectSource: async () => {
        if (!mux) {
          throw new Error('fixture_source_owned_by_desktop')
        }
        return mux
      },
      prepareCatalog: async () => seedPaths,
      desktopDirectory,
      mux,
      destination,
      ...(options.disconnectAfterMigration
        ? {
            reconnectClient: async (assertDisconnected: () => Promise<void>) => {
              await tunnels.close(environmentId)
              await manager.disconnectAll()
              await assertDisconnected()
              const nextConnection = await manager.connect(managedTarget)
              const nextLocalPort = await tunnels.start(
                environmentId,
                managedTarget,
                nextConnection,
                remotePort
              )
              destination.rebindTransport(nextConnection, nextLocalPort)
            }
          }
        : {}),
      seedPaths,
      target,
      targetConnection: { host: target.host, port: target.port, username: 'root' },
      managedTarget,
      connection,
      dispose
    }
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture_live_catalog_start_failed')
    }
    throw error
  }
}
