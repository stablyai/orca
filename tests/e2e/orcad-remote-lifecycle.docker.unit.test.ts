import { createHash, randomBytes } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestInfo } from '@stablyai/playwright-test'

import type { OrcadHealth } from '../../src/main/orcad/orcad-health'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../src/shared/protocol-version'
import { parsePairingCode } from '../../src/shared/pairing'
import { sendRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../src/shared/runtime-environments'
import {
  readRemoteOrcadManagedStopIdentity,
  requestRemoteOrcadManagedDecommission,
  requestRemoteOrcadManagedStopCancellation
} from '../../src/main/ssh/orcad-decommission-client'
import { cancelInterruptedOrcadManagedStop } from '../../src/main/ssh/orcad-managed-stop-cancellation'
import {
  OrcadTerminalCensusSchema,
  type OrcadTerminalCensus
} from '../../src/shared/orcad-terminal-census'
import type { ServeReadiness } from '../../src/main/server/serve-readiness'
import {
  armDockerOrcadTransactionTransportDrop,
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetControlCommand,
  killDockerSshRelayTargetTransports,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { SshHalfOpenProxy } from './helpers/ssh-half-open-proxy'
import { OrcadManagedTunnelManager } from '../../src/main/ssh/orcad-managed-tunnel'
import { computeLocalOrcadBuildHash } from '../../src/main/ssh/orcad-local-build-hash'
import { recoverInterruptedOrcadActivation } from '../../src/main/ssh/orcad-activation-recovery'
import { orcadActivationLockPath } from '../../src/main/ssh/orcad-activation-lock'
import { orcadActivationTransactionPath } from '../../src/main/ssh/orcad-activation-transaction-store'
import { readOrcadActivationRecord } from '../../src/main/ssh/orcad-activation-record-store'
import { deployOrcad } from '../../src/main/ssh/orcad-remote-deploy'
import {
  resolveOrcadRemoteContext,
  type OrcadRemoteContext
} from '../../src/main/ssh/orcad-remote-context'
import { rollbackOrcad } from '../../src/main/ssh/orcad-remote-rollback'
import { stopRemoteOrcad } from '../../src/main/ssh/orcad-remote-stop'
import type { SshConnection } from '../../src/main/ssh/ssh-connection'
import { SshConnectionManager } from '../../src/main/ssh/ssh-connection-manager'
import type { SshConnectionStore } from '../../src/main/ssh/ssh-connection-store'
import { initSshHostKeyStoreFile } from '../../src/main/ssh/ssh-host-key-store'
import { tunneledOrcadPairingCode } from '../../src/main/ssh/orcad-tunneled-pairing'
import type { SshConnectionStatus, SshTarget } from '../../src/shared/ssh-types'
import { computeRemoteInstallDir } from '../../src/main/ssh/ssh-relay-versioned-install'
import { ORCAD_INSTALL_MODEL } from '../../src/main/ssh/remote-install-model'
import { joinRemotePath } from '../../src/main/ssh/ssh-remote-platform'
import { ORCAD_PID_FILENAME } from '../../src/main/ssh/orcad-remote-host-support'
import { execCommand } from '../../src/main/ssh/ssh-relay-deploy-helpers'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime'
import { verifyOrcadLifecycleTerminalRoundTrip } from '../../config/scripts/orcad-bun-lifecycle-terminal-probe.mjs'

const RUN_LIFECYCLE = process.env.ORCA_REVIEW_ORCAD_SSH_LIFECYCLE === '1'
const REMOTE_PORT = 6_768
const ENVIRONMENT_ID = 'orcad-ssh-lifecycle-e2e'

let target: DockerSshRelayTarget | null = null
let halfOpenProxy: SshHalfOpenProxy | null = null
let connection: SshConnection | null = null
let connectionManager: SshConnectionManager | null = null
let context: OrcadRemoteContext | null = null
let managedTarget: SshTarget | null = null
let tunnelManager: OrcadManagedTunnelManager | null = null
let localArtifact = ''
let candidateArtifact = ''
let temporary = ''
const connectionStates: SshConnectionStatus[] = []

async function rpc<TResult>(
  pairingCode: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new Error('Invalid tunneled orcad pairing code')
  }
  const response = await sendRemoteRuntimeRequest<TResult>(
    offer,
    method,
    params,
    30_000,
    undefined,
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.message}`)
  }
  return response.result
}

function pairingCode(readiness: ServeReadiness, localPort: number): string {
  return tunneledOrcadPairingCode(readiness, localPort)
}

function makeCandidateArtifact(source: string, destination: string): string {
  cpSync(source, destination, { recursive: true })
  const entryPath = join(destination, 'orcad.js')
  const entry = readFileSync(entryPath, 'utf8')
  const firstLineEnd = entry.indexOf('\n') + 1
  const activationWindow = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);\n'
  writeFileSync(
    entryPath,
    `${entry.slice(0, firstLineEnd)}${activationWindow}${entry.slice(firstLineEnd)}\n// disposable SSH lifecycle candidate\n`
  )
  const digest = createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 12)
  const version = `0.1.0+${digest}`
  writeFileSync(join(destination, '.version'), `${version}\n`)
  return version
}

async function waitForTerminalText(pairing: string, handle: string, marker: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await rpc<{ terminal: { tail: string[] } }>(pairing, 'terminal.read', {
      terminal: handle
    })
    if (result.terminal.tail.some((line) => line.trim() === marker)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Remote terminal never emitted ${marker}`)
}

async function probeTerminal(pairing: string, handle: string, marker: string): Promise<void> {
  await verifyOrcadLifecycleTerminalRoundTrip({
    marker,
    waitForWritable: async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await rpc<{ terminal: { writable: boolean } }>(pairing, 'terminal.show', {
          terminal: handle
        })
        if (result.terminal.writable) {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error('SSH lifecycle terminal never became writable')
    },
    send: (text: string) => rpc(pairing, 'terminal.send', { terminal: handle, text, enter: true }),
    read: () => rpc(pairing, 'terminal.read', { terminal: handle })
  })
}

async function census(pairing: string, activatedAt: string): Promise<OrcadTerminalCensus> {
  return OrcadTerminalCensusSchema.parse(
    await rpc(pairing, 'orcad.terminalCensus', { activatedAt: Date.parse(activatedAt) })
  )
}

async function waitForNoLiveTerminals(pairing: string, activatedAt: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await census(pairing, activatedAt)).liveSessions === 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Remote terminal census did not drain to zero')
}

async function waitForManagedSshReconnect(previousGeneration: number): Promise<SshConnection> {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const current = connectionManager?.getConnection(ENVIRONMENT_ID)
    if (
      connectionStates.includes('reconnecting') &&
      current?.getState().status === 'connected' &&
      current.getTransportGeneration() > previousGeneration
    ) {
      return current
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Managed SSH transport never reconnected on a new generation')
}

function readRecord() {
  return readOrcadActivationRecord({
    conn: connection!,
    host: context!.host,
    remoteHome: context!.remoteHome
  })
}

describe.skipIf(!RUN_LIFECYCLE)('managed orcad lifecycle over disposable SSH', () => {
  beforeAll(async () => {
    localArtifact = process.env.ORCA_REVIEW_ORCAD_ARTIFACT_DIR ?? ''
    if (!localArtifact) {
      throw new Error('ORCA_REVIEW_ORCAD_ARTIFACT_DIR is required')
    }
    temporary = mkdtempSync(join(dirname(localArtifact), '.orcad-ssh-lifecycle-'))
    candidateArtifact = join(temporary, 'candidate')
    initSshHostKeyStoreFile(join(temporary, 'ssh-host-keys.json'))
    target = startDockerSshRelayTarget({ workerIndex: 0 } as TestInfo)
    halfOpenProxy = await SshHalfOpenProxy.start(target.host, target.port)
    managedTarget = {
      id: ENVIRONMENT_ID,
      label: 'Disposable managed orcad SSH target',
      source: 'manual' as const,
      host: target.host,
      port: halfOpenProxy.port,
      username: 'root',
      identityFile: target.identityFile,
      identitiesOnly: true,
      generation: 1,
      owner: { type: 'orcad-runtime', environmentId: ENVIRONMENT_ID }
    }
    connectionManager = new SshConnectionManager({
      onStateChange: (_targetId, state) => connectionStates.push(state.status)
    })
    connection = await connectionManager.connect(managedTarget)
    if (process.env.ORCA_REVIEW_ORCAD_NO_HOST_NODE === '1') {
      expect(
        await execCommand(
          connection,
          'for runtime in node nodejs npm npx; do if command -v "$runtime" >/dev/null 2>&1; then exit 1; fi; done; printf NO_HOST_NODE'
        )
      ).toBe('NO_HOST_NODE')
    }
    const targetStore = {
      getTarget: (targetId: string) => (targetId === managedTarget?.id ? managedTarget : undefined)
    } as SshConnectionStore
    tunnelManager = new OrcadManagedTunnelManager({
      getConnectionManager: () => connectionManager,
      getTargetStore: () => targetStore
    })
    context = await resolveOrcadRemoteContext(managedTarget, connection)
    expect(context.bunTarget).toBe(process.env.ORCA_REVIEW_ORCAD_TARGET)
  }, 180_000)

  afterAll(async () => {
    await tunnelManager?.close(ENVIRONMENT_ID).catch(() => undefined)
    tunnelManager?.dispose()
    await connectionManager?.disconnectAll().catch(() => undefined)
    await halfOpenProxy?.close().catch(() => undefined)
    cleanupDockerSshRelayTarget(target)
    if (temporary) {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('preserves a live PTY through update and rollback, then decommissions idempotently', async () => {
    const activeContext = context!
    const activeConnection = connection!
    const activeTarget = activeContext.target
    const initialVersion = readFileSync(join(localArtifact, '.version'), 'utf8').trim()
    const candidateVersion = makeCandidateArtifact(localArtifact, candidateArtifact)
    expect(candidateVersion).not.toBe(initialVersion)

    const initial = await deployOrcad({
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      localOrcadDir: localArtifact,
      buildTarget: activeContext.bunTarget,
      userDataDir: activeContext.userDataDir,
      bindHost: '127.0.0.1',
      port: REMOTE_PORT,
      census: { liveSessions: 0, startedSinceActivation: 0 }
    })
    expect(initial.outcome).toBe('installed-and-activated')
    if (initial.outcome !== 'installed-and-activated') {
      throw new Error(`Initial deployment did not activate: ${JSON.stringify(initial)}`)
    }
    expect(initial.readiness.health).toMatchObject({
      runtimeKind: 'bun',
      runtimeVersion: ORCAD_BUN_VERSION,
      ptyBackend: 'bun-terminal'
    })
    const daemonPid = initial.readiness.health?.terminalDaemon.pid
    expect(daemonPid).toBeGreaterThan(0)
    const localPort = await tunnelManager!.start(
      ENVIRONMENT_ID,
      activeTarget,
      activeConnection,
      REMOTE_PORT
    )
    const initialPairing = pairingCode(initial.readiness, localPort)

    const repoResult = await rpc<{ repo: { id: string } }>(initialPairing, 'repo.add', {
      path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
    })
    const worktreeList = await rpc<{ worktrees: { id: string; path: string }[] }>(
      initialPairing,
      'worktree.list',
      { repo: `id:${repoResult.repo.id}`, limit: 100 }
    )
    const worktree = worktreeList.worktrees.find(
      (candidate) => candidate.path === DOCKER_SSH_RELAY_REMOTE_REPO_PATH
    )
    if (!worktree) {
      throw new Error('Seeded remote repository did not publish its main worktree')
    }
    const terminalResult = await rpc<{ terminal: { handle: string } }>(
      initialPairing,
      'terminal.create',
      { worktree: worktree.id }
    )
    const handle = terminalResult.terminal.handle
    const marker = `ORCAD_BUN_LIFECYCLE_SSH_${randomBytes(8).toString('hex')}`
    await probeTerminal(initialPairing, handle, marker)

    const managedOffer = parsePairingCode(initialPairing)
    if (!managedOffer) {
      throw new Error('Initial managed orcad pairing code was invalid')
    }
    const managedEnvironment: KnownRuntimeEnvironment = createEnvironmentFromPairingOffer({
      id: ENVIRONMENT_ID,
      name: 'Disposable managed orcad SSH target',
      now: Date.now(),
      offer: managedOffer,
      runtimeId: initial.readiness.runtimeId,
      connectionDependency: 'ssh-tunnel',
      orcadDeployment: {
        sshTargetId: activeTarget.id,
        sshTargetGeneration: activeTarget.generation!,
        localPort,
        remotePort: REMOTE_PORT
      }
    })

    const halfOpenTransportGeneration = activeConnection.getTransportGeneration()
    connectionStates.length = 0
    expect(halfOpenProxy!.blackholeEstablishedConnections()).toBeGreaterThan(0)
    const wakeRecoveryStartedAt = Date.now()
    await tunnelManager!.recoverAfterHostResume({
      attempts: 2,
      resolveEnvironment: (environmentId) =>
        environmentId === managedEnvironment.id ? managedEnvironment : null,
      timeoutMs: 5_000
    })
    const halfOpenReconnect = connectionManager!.getConnection(ENVIRONMENT_ID)
    expect(halfOpenReconnect).toBe(activeConnection)
    expect(connectionStates).toContain('reconnecting')
    expect(activeConnection.getTransportGeneration()).toBeGreaterThan(halfOpenTransportGeneration)
    expect(Date.now() - wakeRecoveryStartedAt).toBeLessThan(30_000)
    const halfOpenPairing = pairingCode(initial.readiness, localPort)
    const halfOpenHealth = await rpc<OrcadHealth>(halfOpenPairing, 'orcad.health', {})
    expect(halfOpenHealth.terminalDaemon.pid).toBe(daemonPid)
    await waitForTerminalText(halfOpenPairing, handle, marker)
    const halfOpenMarker = `ORCAD_BUN_LIFECYCLE_SSH_HALF_OPEN_${randomBytes(8).toString('hex')}`
    await probeTerminal(halfOpenPairing, handle, halfOpenMarker)

    const transportGeneration = activeConnection.getTransportGeneration()
    connectionStates.length = 0
    expect(killDockerSshRelayTargetTransports(target!)).toBeGreaterThan(0)
    const reconnectedConnection = await waitForManagedSshReconnect(transportGeneration)
    expect(reconnectedConnection).toBe(activeConnection)
    await tunnelManager!.ensure(managedEnvironment)

    const reconnectedPairing = pairingCode(initial.readiness, localPort)
    const reconnectedHealth = await rpc<OrcadHealth>(reconnectedPairing, 'orcad.health', {})
    expect(reconnectedHealth.terminalDaemon.pid).toBe(daemonPid)
    await waitForTerminalText(reconnectedPairing, handle, marker)
    const reconnectedMarker = `ORCAD_BUN_LIFECYCLE_SSH_RECONNECTED_${randomBytes(8).toString('hex')}`
    await probeTerminal(reconnectedPairing, handle, reconnectedMarker)

    const firstRecord = await readRecord()
    const firstCensus = await census(reconnectedPairing, firstRecord.activatedAt!)
    expect(firstCensus.liveSessions).toBe(1)
    const deferred = await deployOrcad({
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      localOrcadDir: candidateArtifact,
      buildTarget: activeContext.bunTarget,
      userDataDir: activeContext.userDataDir,
      bindHost: '127.0.0.1',
      port: REMOTE_PORT,
      census: firstCensus
    })
    expect(deferred).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_update_terminals_running'
    })
    expect((await readRecord()).active).toBe(initialVersion)

    const candidateDir = computeRemoteInstallDir(
      ORCAD_INSTALL_MODEL,
      activeContext.remoteHome,
      candidateVersion,
      activeContext.host.pathFlavor
    )
    const mutationDropMarker = '/tmp/orca-orcad-activation-drop'
    armDockerOrcadTransactionTransportDrop(target!, {
      transactionPath: orcadActivationTransactionPath(activeContext.host, activeContext.remoteHome),
      operation: 'activate',
      phase: 'snapshot-captured',
      suspendPidPath: joinRemotePath(activeContext.host, candidateDir, ORCAD_PID_FILENAME),
      markerPath: mutationDropMarker
    })
    const mutationTransportGeneration = activeConnection.getTransportGeneration()
    connectionStates.length = 0
    await expect(
      deployOrcad({
        conn: activeConnection,
        host: activeContext.host,
        remoteHome: activeContext.remoteHome,
        localOrcadDir: candidateArtifact,
        buildTarget: activeContext.bunTarget,
        userDataDir: activeContext.userDataDir,
        bindHost: '127.0.0.1',
        port: REMOTE_PORT,
        census: firstCensus,
        force: true
      })
    ).rejects.toThrow()
    const stoppedCandidatePid = execDockerSshRelayTargetControlCommand(
      target!,
      `cat '${mutationDropMarker}'`
    )
    expect(stoppedCandidatePid).toMatch(/^[1-9][0-9]*$/u)
    const mutationReconnect = await waitForManagedSshReconnect(mutationTransportGeneration)
    expect(mutationReconnect).toBe(activeConnection)
    execDockerSshRelayTargetControlCommand(
      target!,
      `kill -CONT '${stoppedCandidatePid}' && touch -d '25 minutes ago' '${orcadActivationLockPath(activeContext.host, activeContext.remoteHome)}'`
    )
    await tunnelManager!.ensure(managedEnvironment)
    const recovered = await recoverInterruptedOrcadActivation({
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      userDataDir: activeContext.userDataDir,
      bindHost: '127.0.0.1',
      port: REMOTE_PORT
    })
    expect(recovered).toMatchObject({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: initialVersion
    })
    if (recovered.outcome !== 'recovered' || !recovered.readiness) {
      throw new Error(`Interrupted activation did not recover: ${JSON.stringify(recovered)}`)
    }
    expect(recovered.readiness.health?.terminalDaemon.pid).toBe(daemonPid)
    expect((await readRecord()).active).toBe(initialVersion)
    const recoveredPairing = pairingCode(recovered.readiness, localPort)
    await waitForTerminalText(recoveredPairing, handle, marker)

    const updated = await deployOrcad({
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      localOrcadDir: candidateArtifact,
      buildTarget: activeContext.bunTarget,
      userDataDir: activeContext.userDataDir,
      bindHost: '127.0.0.1',
      port: REMOTE_PORT,
      census: firstCensus,
      force: true
    })
    expect(updated.outcome).toBe('installed-and-activated')
    if (updated.outcome !== 'installed-and-activated') {
      throw new Error(`Forced update did not activate: ${JSON.stringify(updated)}`)
    }
    expect(updated.readiness.health?.terminalDaemon.pid).toBe(daemonPid)
    const updatedPairing = pairingCode(updated.readiness, localPort)
    await waitForTerminalText(updatedPairing, handle, marker)
    await probeTerminal(
      updatedPairing,
      handle,
      `ORCAD_BUN_LIFECYCLE_SSH_UPDATED_${randomBytes(8).toString('hex')}`
    )

    const updatedRecord = await readRecord()
    expect(updatedRecord).toMatchObject({ active: candidateVersion, previous: initialVersion })
    const updatedCensus = await census(updatedPairing, updatedRecord.activatedAt!)
    expect(updatedCensus).toEqual({
      liveSessions: 1,
      startedSinceActivation: 0
    })

    const rollbackDropMarker = '/tmp/orca-orcad-rollback-drop'
    armDockerOrcadTransactionTransportDrop(target!, {
      transactionPath: orcadActivationTransactionPath(activeContext.host, activeContext.remoteHome),
      operation: 'rollback',
      phase: 'rollback-state-restored',
      markerPath: rollbackDropMarker
    })
    const rollbackTransportGeneration = activeConnection.getTransportGeneration()
    connectionStates.length = 0
    await expect(
      rollbackOrcad({
        conn: activeConnection,
        host: activeContext.host,
        remoteHome: activeContext.remoteHome,
        record: updatedRecord,
        userDataDir: activeContext.userDataDir,
        bindHost: '127.0.0.1',
        port: REMOTE_PORT,
        census: updatedCensus,
        targetBuildHash: computeLocalOrcadBuildHash(localArtifact)
      })
    ).resolves.toMatchObject({
      outcome: 'failed',
      code: 'orcad_rollback_target_stop_unverifiable'
    })
    expect(execDockerSshRelayTargetControlCommand(target!, `cat '${rollbackDropMarker}'`)).toBe(
      'DROPPED'
    )
    const rollbackReconnect = await waitForManagedSshReconnect(rollbackTransportGeneration)
    expect(rollbackReconnect).toBe(activeConnection)
    execDockerSshRelayTargetControlCommand(
      target!,
      `touch -d '25 minutes ago' '${orcadActivationLockPath(activeContext.host, activeContext.remoteHome)}'`
    )
    await tunnelManager!.ensure(managedEnvironment)
    const recoveredRollback = await recoverInterruptedOrcadActivation({
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      userDataDir: activeContext.userDataDir,
      bindHost: '127.0.0.1',
      port: REMOTE_PORT
    })
    expect(recoveredRollback).toMatchObject({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: candidateVersion
    })
    if (recoveredRollback.outcome !== 'recovered' || !recoveredRollback.readiness) {
      throw new Error(`Interrupted rollback did not recover: ${JSON.stringify(recoveredRollback)}`)
    }
    expect(recoveredRollback.readiness.health?.terminalDaemon.pid).toBe(daemonPid)
    const recoveredRollbackPairing = pairingCode(recoveredRollback.readiness, localPort)
    await waitForTerminalText(recoveredRollbackPairing, handle, marker)
    const recoveredUpdatedRecord = await readRecord()
    expect(recoveredUpdatedRecord).toMatchObject({
      active: candidateVersion,
      previous: initialVersion
    })
    const recoveredUpdatedCensus = await census(
      recoveredRollbackPairing,
      recoveredUpdatedRecord.activatedAt!
    )
    const rolledBack = await rollbackOrcad({
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      record: recoveredUpdatedRecord,
      userDataDir: activeContext.userDataDir,
      bindHost: '127.0.0.1',
      port: REMOTE_PORT,
      census: recoveredUpdatedCensus,
      targetBuildHash: computeLocalOrcadBuildHash(localArtifact)
    })
    expect(rolledBack.outcome).toBe('rolled-back')
    if (rolledBack.outcome !== 'rolled-back') {
      throw new Error(`Rollback failed: ${JSON.stringify(rolledBack)}`)
    }
    expect(rolledBack.readiness.health?.terminalDaemon.pid).toBe(daemonPid)
    const rollbackPairing = pairingCode(rolledBack.readiness, localPort)
    await waitForTerminalText(rollbackPairing, handle, marker)
    await probeTerminal(
      rollbackPairing,
      handle,
      `ORCAD_BUN_LIFECYCLE_SSH_ROLLBACK_${randomBytes(8).toString('hex')}`
    )

    const stopOptions = {
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      requestDecommission: async () => {
        throw new Error('Managed stop must not use the legacy RPC')
      },
      managedStop: {
        runtimeId: initial.readiness.runtimeId,
        readIdentity: (version: string) =>
          readRemoteOrcadManagedStopIdentity(managedEnvironment, version),
        requestDecommission: (
          version: string,
          authority: Parameters<typeof requestRemoteOrcadManagedDecommission>[2]
        ) => requestRemoteOrcadManagedDecommission(managedEnvironment, version, authority)
      }
    }
    const liveDecommission = await stopRemoteOrcad({ ...stopOptions, record: await readRecord() })
    expect(liveDecommission, JSON.stringify(liveDecommission)).toMatchObject({
      outcome: 'refused',
      verdict: 'live'
    })
    execDockerSshRelayTargetControlCommand(
      target!,
      `touch -d '25 minutes ago' '${orcadActivationLockPath(activeContext.host, activeContext.remoteHome)}'`
    )
    const canceled = await cancelInterruptedOrcadManagedStop({
      ...stopOptions,
      runtimeId: initial.readiness.runtimeId,
      requestCancellation: (request) =>
        requestRemoteOrcadManagedStopCancellation(managedEnvironment, request)
    })
    expect(canceled, JSON.stringify(canceled)).toMatchObject({ outcome: 'canceled' })
    await probeTerminal(
      rollbackPairing,
      handle,
      `ORCAD_BUN_LIFECYCLE_SSH_CANCELED_STOP_${randomBytes(8).toString('hex')}`
    )
    await rpc(rollbackPairing, 'terminal.close', { terminal: handle })
    const rollbackRecord = await readRecord()
    await waitForNoLiveTerminals(rollbackPairing, rollbackRecord.activatedAt!)
    expect(await census(rollbackPairing, rollbackRecord.activatedAt!)).toEqual({
      liveSessions: 0,
      startedSinceActivation: 0
    })

    const decommissionTransportGeneration = activeConnection.getTransportGeneration()
    connectionStates.length = 0
    let acceptedDecommissionTransactionId = ''
    await expect(
      stopRemoteOrcad({
        ...stopOptions,
        record: rollbackRecord,
        managedStop: {
          ...stopOptions.managedStop,
          requestDecommission: async (version, authority) => {
            const accepted = await stopOptions.managedStop.requestDecommission(version, authority)
            expect(accepted).toEqual({
              outcome: 'accepted',
              transactionId: authority.transactionId,
              authority
            })
            acceptedDecommissionTransactionId = authority.transactionId
            expect(killDockerSshRelayTargetTransports(target!)).toBeGreaterThan(0)
            throw new Error('Simulated loss of the accepted decommission response')
          }
        }
      })
    ).rejects.toThrow('Simulated loss of the accepted decommission response')
    expect(acceptedDecommissionTransactionId).not.toBe('')
    const decommissionReconnect = await waitForManagedSshReconnect(decommissionTransportGeneration)
    expect(decommissionReconnect).toBe(activeConnection)
    execDockerSshRelayTargetControlCommand(
      target!,
      `touch -d '25 minutes ago' '${orcadActivationLockPath(activeContext.host, activeContext.remoteHome)}'`
    )
    const recoveredStop = await recoverInterruptedOrcadActivation({
      conn: activeConnection,
      host: activeContext.host,
      remoteHome: activeContext.remoteHome,
      userDataDir: activeContext.userDataDir,
      bindHost: '127.0.0.1',
      port: REMOTE_PORT,
      requestManagedDecommission: stopOptions.managedStop.requestDecommission
    })
    expect(recoveredStop).toMatchObject({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null,
      readiness: null
    })
    const deactivated = await readRecord()
    expect(deactivated.active).toBeNull()
    const retried = await stopRemoteOrcad({
      ...stopOptions,
      record: deactivated,
      managedStop: {
        runtimeId: initial.readiness.runtimeId,
        readIdentity: async () => {
          throw new Error('Already-deactivated retry must use the completed receipt')
        },
        requestDecommission: async () => {
          throw new Error('Already-deactivated retry must not call the stopped runtime')
        }
      }
    })
    expect(retried).toMatchObject({ outcome: 'stopped', alreadyDeactivated: true })
  }, 300_000)
})
