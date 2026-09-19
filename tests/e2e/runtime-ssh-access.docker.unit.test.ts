import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { describe, expect, it } from 'vitest'
import { Store } from '../../src/main/persistence'
import { SshConnectionStore } from '../../src/main/ssh/ssh-connection-store'
import { SshConnectionManager } from '../../src/main/ssh/ssh-connection-manager'
import { initSshHostKeyStoreFile } from '../../src/main/ssh/ssh-host-key-store'
import {
  setSshConnectionManagerResolver,
  setSshTargetRegistryStore
} from '../../src/main/ssh/ssh-target-registry'
import {
  closeOrcadManagedTunnel,
  ensureOrcadManagedTunnel,
  OrcadManagedTunnelManager
} from '../../src/main/ssh/orcad-managed-tunnel'
import { linkRuntimeSshAccess, unlinkRuntimeSshAccess } from '../../src/main/ssh/runtime-ssh-access'
import { tunneledOrcadPairingCode } from '../../src/main/ssh/orcad-tunneled-pairing'
import type { ServeReadiness } from '../../src/main/server/serve-readiness'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed,
  resolveEnvironment,
  resolveEnvironmentPairingOffer
} from '../../src/shared/runtime-environment-store'
import { sendRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../src/shared/protocol-version'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'
import {
  cleanupDockerSshRelayTarget,
  copyFileIntoDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  killDockerSshRelayTargetTransports,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'

const PORT = 6779
const PROFILE = '/tmp/independent-orcad-profile'
const ID = 'independent-ssh-access'

async function startIndependentHost(target: DockerSshRelayTarget): Promise<ServeReadiness> {
  execDockerSshRelayTargetCommand(
    target,
    `ORCA_BACKGROUND_LAUNCH=1 ORCA_USER_DATA=${PROFILE} nohup /tmp/independent-orcad/bun-runtime /tmp/independent-orcad/orcad.js --port ${PORT} --json >/tmp/independent-orcad.log 2>&1 </dev/null &`
  )
  let ready: ServeReadiness | undefined
  await expect
    .poll(
      () => {
        const logs = execDockerSshRelayTargetCommand(target, 'cat /tmp/independent-orcad.log')
        const line = logs.split('\n').find((row) => row.startsWith('{"type":"orca_server_ready"'))
        if (line) {
          ready = JSON.parse(line) as ServeReadiness
        }
        return !!ready
      },
      { timeout: 90_000 }
    )
    .toBe(true)
  return ready!
}

describe.skipIf(process.env.ORCA_REVIEW_ORCAD_SSH_LIFECYCLE !== '1')(
  'independently launched Bun host SSH access',
  () => {
    it('preserves profile, identity and live PTY through link, recovery and unlink without Node', async () => {
      const artifact = process.env.ORCA_REVIEW_ORCAD_ARTIFACT_DIR
      if (!artifact) {
        throw new Error('ORCA_REVIEW_ORCAD_ARTIFACT_DIR is required')
      }
      const local = mkdtempSync(join(tmpdir(), 'orca-independent-ssh-'))
      let target: DockerSshRelayTarget | null = null
      const connectionStates: string[] = []
      const manager = new SshConnectionManager({
        onStateChange: (_targetId, state) => connectionStates.push(state.status)
      })
      const store = new Store({ dataFile: join(local, 'state.json') })
      const targets = new SshConnectionStore(store)
      const originalTunnel = new OrcadManagedTunnelManager({
        getConnectionManager: () => manager,
        getTargetStore: () => targets
      })
      const rpc = async <T>(method: string, params: unknown): Promise<T> => {
        const offer = resolveEnvironmentPairingOffer(local, ID)
        const response = await sendRemoteRuntimeRequest<T>(
          offer,
          method,
          params,
          30_000,
          undefined,
          undefined,
          ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
        )
        if (!response.ok) {
          throw new Error(`${method}: ${response.error.message}`)
        }
        return response.result
      }
      try {
        initSshHostKeyStoreFile(join(local, 'host-keys.json'))
        setSshTargetRegistryStore(targets)
        setSshConnectionManagerResolver(() => manager)
        target = startDockerSshRelayTarget({ workerIndex: 0 } as TestInfo)
        copyFileIntoDockerSshRelayTarget(target, artifact, '/tmp/independent-orcad')
        // Only the disposable container loses Node; the independent profile is never deployed over.
        execDockerSshRelayTargetCommand(
          target,
          'mkdir /tmp/disabled-node && mv /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /tmp/disabled-node/'
        )
        const noNode =
          'if command -v node || command -v npm; then exit 1; fi; printf NODE_NPM_ABSENT'
        expect(execDockerSshRelayTargetCommand(target, noNode)).toBe('NODE_NPM_ABSENT')
        execDockerSshRelayTargetCommand(
          target,
          `mkdir -p ${PROFILE}; printf profile-sentinel > ${PROFILE}/operator-owned`
        )
        const ready = await startIndependentHost(target)
        expect(ready!.health).toMatchObject({
          runtimeKind: 'bun',
          runtimeVersion: ORCAD_BUN_VERSION,
          terminalDaemon: { runtimeKind: 'bun', runtimeVersion: ORCAD_BUN_VERSION }
        })
        const ssh = targets.addTarget({
          label: 'Independent host access',
          host: target.host,
          port: target.port,
          username: 'root',
          identityFile: target.identityFile,
          identitiesOnly: true
        })
        await store.flushPendingOrThrowAsync()
        const connection = await manager.connect(ssh)
        const originalPort = await originalTunnel.start(ID, ssh, connection, PORT)
        addEnvironmentFromPairingCode(local, {
          id: ID,
          name: 'Independent server',
          pairingCode: tunneledOrcadPairingCode(ready!, originalPort)
        })
        markEnvironmentUsed(local, ID, { runtimeId: ready!.runtimeId })
        const before = resolveEnvironment(local, ID)
        const { repo } = await rpc<{ repo: { id: string } }>('repo.add', {
          path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
        })
        const { worktrees } = await rpc<{ worktrees: { id: string; path: string }[] }>(
          'worktree.list',
          {
            repo: `id:${repo.id}`,
            limit: 100
          }
        )
        const worktree = worktrees.find((row) => row.path === DOCKER_SSH_RELAY_REMOTE_REPO_PATH)!
        const folderPath = '/tmp/independent-folder-workspace'
        execDockerSshRelayTargetCommand(target, `mkdir ${folderPath}`)
        const { group } = await rpc<{ group: { id: string } }>('projectGroup.create', {
          name: 'Independent non-git project',
          parentPath: folderPath
        })
        const { folderWorkspace } = await rpc<{ folderWorkspace: { id: string } }>(
          'folderWorkspace.create',
          { projectGroupId: group.id, name: 'Independent folder', folderPath }
        )
        const terminals: { handle: string; sentinel: string }[] = []
        for (const [index, workspace] of [
          worktree.id,
          `id:${folderWorkspaceKey(folderWorkspace.id)}`
        ].entries()) {
          const { terminal } = await rpc<{ terminal: { handle: string } }>('terminal.create', {
            worktree: workspace
          })
          const sentinel = `incumbent_${index}`
          terminals.push({ handle: terminal.handle, sentinel })
          await rpc('terminal.send', {
            terminal: terminal.handle,
            text: `export ORCA_ACCESS_SENTINEL=${sentinel}`,
            enter: true
          })
        }
        const proveSameShell = async (suffix: string) => {
          for (const terminal of terminals) {
            const sent = await rpc<{ send: { accepted: boolean } }>('terminal.send', {
              terminal: terminal.handle,
              text: `printf '%s_%s\\n' "$ORCA_ACCESS_SENTINEL" '${suffix}'`,
              enter: true
            })
            expect(sent.send.accepted, `${terminal.sentinel}: ${suffix}`).toBe(true)
            await expect
              .poll(
                async () =>
                  JSON.stringify(
                    await rpc('terminal.read', {
                      terminal: terminal.handle
                    })
                  ),
                { timeout: 15_000 }
              )
              .toContain(`${terminal.sentinel}_${suffix}`)
          }
        }
        await proveSameShell('before')
        await expect(
          linkRuntimeSshAccess(local, {
            selector: ID,
            requestId: 'failed-link',
            sshTargetId: ssh.id,
            remotePort: PORT + 1
          })
        ).rejects.toThrow()
        expect(resolveEnvironment(local, ID).pendingSshAccessOperation).toMatchObject({
          operation: 'link',
          requestId: 'failed-link'
        })
        await unlinkRuntimeSshAccess(
          local,
          {
            selector: ID,
            requestId: 'failed-link'
          },
          { invalidateTransport: () => {} }
        )
        expect(resolveEnvironment(local, ID).pendingSshAccessOperation).toBeUndefined()
        await proveSameShell('cancelled')
        const linked = await linkRuntimeSshAccess(local, {
          selector: ID,
          requestId: 'link-independent',
          sshTargetId: ssh.id,
          remotePort: PORT
        })
        expect(linked.id).toBe(ID)
        expect(linked.runtimeId).toBe(before.runtimeId)
        expect(linked.orcadDeployment).toBeUndefined()
        expect(linked.sshAccess).toBeDefined()
        await linkRuntimeSshAccess(local, {
          selector: ID,
          requestId: 'link-independent',
          sshTargetId: ssh.id,
          remotePort: PORT
        })
        await proveSameShell('linked')
        await closeOrcadManagedTunnel(ID)
        await ensureOrcadManagedTunnel(local, ID)
        await proveSameShell('recovered')
        const transportGeneration = connection.getTransportGeneration()
        connectionStates.length = 0
        expect(killDockerSshRelayTargetTransports(target)).toBeGreaterThan(0)
        await expect
          .poll(
            () =>
              connectionStates.includes('reconnecting') &&
              manager.getState(ssh.id)?.status === 'connected' &&
              connection.getTransportGeneration() > transportGeneration,
            { timeout: 90_000 }
          )
          .toBe(true)
        await ensureOrcadManagedTunnel(local, ID)
        await proveSameShell('ssh-reconnected')
        // The original access route is an independently owned test forward, not a deployment.
        await originalTunnel.ensure({
          ...before,
          connectionDependency: 'ssh-tunnel',
          orcadDeployment: {
            sshTargetId: ssh.id,
            sshTargetGeneration: ssh.generation!,
            localPort: originalPort,
            remotePort: PORT
          }
        })
        const pid = ready.health?.pid
        expect(ready.health?.terminalDaemon.pid).toBeGreaterThan(0)
        if (!Number.isSafeInteger(pid) || pid! <= 0) {
          throw new Error('Independent runtime did not publish a safe process ID')
        }
        execDockerSshRelayTargetCommand(target, `kill -TERM ${pid}`)
        await expect
          .poll(
            () =>
              execDockerSshRelayTargetCommand(
                target!,
                `if test -r /proc/${pid}/stat; then awk '{print $3}' /proc/${pid}/stat; else printf absent; fi`
              ),
            { timeout: 30_000 }
          )
          .toMatch(/^(absent|Z)$/)
        const restarted = await startIndependentHost(target)
        expect(restarted.runtimeId).toBe(ready.runtimeId)
        expect(restarted.health?.pid).not.toBe(pid)
        expect(restarted.health?.terminalDaemon.pid).toBe(ready.health?.terminalDaemon.pid)
        expect(await rpc('folderWorkspace.list', undefined)).toMatchObject({
          folderWorkspaces: expect.arrayContaining([
            expect.objectContaining({ id: folderWorkspace.id, folderPath })
          ])
        })
        await proveSameShell('restarted')
        await unlinkRuntimeSshAccess(
          local,
          {
            selector: ID,
            requestId: 'unlink-independent'
          },
          { invalidateTransport: () => {} }
        )
        const after = resolveEnvironment(local, ID)
        expect(after.runtimeId).toBe(before.runtimeId)
        expect(after.endpoints).toEqual(before.endpoints)
        expect(after.preferredEndpointId).toBe(before.preferredEndpointId)
        expect(after.sshAccess).toBeUndefined()
        expect(after.pendingSshAccessOperation).toBeUndefined()
        expect(targets.getTarget(ssh.id)?.owner).toBeUndefined()
        await proveSameShell('unlinked')
        await unlinkRuntimeSshAccess(
          local,
          {
            selector: ID,
            requestId: 'unlink-independent'
          },
          { invalidateTransport: () => {} }
        )
        expect(await rpc('worktree.list', { repo: `id:${repo.id}`, limit: 100 })).toMatchObject({
          worktrees
        })
        expect(execDockerSshRelayTargetCommand(target, `cat ${PROFILE}/operator-owned`)).toBe(
          'profile-sentinel'
        )
        expect(execDockerSshRelayTargetCommand(target, noNode)).toBe('NODE_NPM_ABSENT')
      } finally {
        try {
          await Promise.allSettled([closeOrcadManagedTunnel(ID), originalTunnel.close(ID)])
          originalTunnel.dispose()
          await manager.disconnectAll()
          await store.flushPendingOrThrowAsync()
        } finally {
          setSshConnectionManagerResolver(() => null)
          setSshTargetRegistryStore(null)
          cleanupDockerSshRelayTarget(target)
          rmSync(local, { recursive: true, force: true })
        }
      }
    }, 240_000)
  }
)
