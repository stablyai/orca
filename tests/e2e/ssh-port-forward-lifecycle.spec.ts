import { createServer } from 'node:net'

import { test, expect } from './helpers/mcode-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  installSshPortForwardSnapshotBarrier,
  readSshPortForwardSnapshotBarrier,
  releaseSshPortForwardSnapshotBarrier,
  reserveLocalPort,
  restoreSshPortForwardSnapshotHandler
} from './helpers/ssh-port-forward-snapshot-barrier'
import {
  addPortForward,
  expectForwardEvidence,
  forwardPortFromPanel,
  installLifecycleWarningCapture,
  installRendererForwardCapture,
  openPortsPanel,
  readLifecycleWarnings,
  readPortForwardEvidence,
  readRemoteListenerIdentity,
  requestForward,
  restoreLifecycleWarningCapture,
  startRemoteHttpListener
} from './helpers/ssh-port-forward-lifecycle-evidence'
import {
  forceDockerSshRelayChannelReconnect,
  readSshStateCapture,
  readSystemSshInvocationKinds,
  trustDockerSshHost
} from './helpers/ssh-port-forward-transport-evidence'

const RUN_DOCKER_SSH = process.env.MCODE_E2E_SSH_DOCKER === '1'
const FORCE_SYSTEM_SSH = process.env.MCODE_SSH_FORCE_SYSTEM_TRANSPORT === '1'
const REMOTE_PORT = 7860
const REFRESH_BARRIER_PORT = 7861
const SCAN_REFRESH_PORT = 7862

test.describe('Docker SSH port-forward lifecycle', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set MCODE_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH lifecycle uses POSIX process inspection.')

  test('keeps a user-forwarded listener live across scan refresh @headful', async ({
    electronApp,
    mcodePage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    const localPortReservation = await reserveLocalPort()
    const unrelatedLocalPortReservation = await reserveLocalPort()
    const localPort = localPortReservation.port
    const unrelatedLocalPort = unrelatedLocalPortReservation.port
    const marker = `MCODE_FORWARD_${Date.now()}`
    const unrelatedMarker = `${marker}_UNRELATED`
    try {
      target = startDockerSshRelayTarget(testInfo)
      const systemSshInvocationLogPath = await trustDockerSshHost(electronApp, target)
      await installLifecycleWarningCapture(electronApp)
      await waitForSessionReady(mcodePage)
      await waitForActiveWorktree(mcodePage)
      const remote = await connectDockerSshRelayTarget(mcodePage, target)
      const remotePid = startRemoteHttpListener(target, REMOTE_PORT, marker)
      const unrelatedRemotePid = startRemoteHttpListener(
        target,
        REFRESH_BARRIER_PORT,
        unrelatedMarker
      )
      await openPortsPanel(mcodePage)

      await expect
        .poll(
          () =>
            mcodePage.evaluate(
              ({ targetId, port }) =>
                window.api.ssh
                  .listDetectedPorts({ targetId })
                  .then((ports) => ports.find((entry) => entry.port === port)?.pid ?? null),
              { targetId: remote.targetId, port: REMOTE_PORT }
            ),
          { timeout: 45_000, message: 'remote HTTP listener was not detected' }
        )
        .toBe(remotePid)
      await expect(mcodePage.getByText(`:${REMOTE_PORT}`, { exact: true })).toBeVisible()
      await expect
        .poll(
          () =>
            mcodePage.evaluate(
              ({ targetId, port }) =>
                window.api.ssh
                  .listDetectedPorts({ targetId })
                  .then((ports) => ports.some((entry) => entry.port === port)),
              { targetId: remote.targetId, port: REFRESH_BARRIER_PORT }
            ),
          { timeout: 45_000, message: 'scan-refresh barrier listener was not detected' }
        )
        .toBe(true)
      await expect(mcodePage.getByText(`:${REFRESH_BARRIER_PORT}`, { exact: true })).toBeVisible()

      await installSshPortForwardSnapshotBarrier(electronApp, remote.targetId)
      await mcodePage.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
      await mcodePage.reload()
      await waitForSessionReady(mcodePage, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(mcodePage), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      await expect
        .poll(
          () =>
            mcodePage.evaluate(
              (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status,
              remote.targetId
            ),
          { timeout: 60_000, message: 'renderer did not restore the connected SSH target' }
        )
        .toBe('connected')
      await expect
        .poll(() => readSshPortForwardSnapshotBarrier(electronApp), {
          timeout: 30_000,
          message: 'renderer hydration did not capture an empty Forwarded snapshot'
        })
        .toEqual({ captured: true, released: false })

      await installRendererForwardCapture(mcodePage)
      await openPortsPanel(mcodePage)
      await localPortReservation.release()
      await forwardPortFromPanel(mcodePage, localPort, REMOTE_PORT)
      await expect(mcodePage.getByText('Forwarded', { exact: true })).toBeVisible()
      await expect(
        mcodePage.getByText(`:${localPort} → :${REMOTE_PORT}`, { exact: true })
      ).toBeVisible()
      await expect.poll(() => requestForward(localPort)).toContain(marker)
      await expectForwardEvidence(mcodePage, remote.targetId, [
        { localPort, remotePort: REMOTE_PORT }
      ])
      if (FORCE_SYSTEM_SSH) {
        await expect
          .poll(() => readSystemSshInvocationKinds(systemSshInvocationLogPath))
          .toContain('forward')
      } else {
        expect(readSystemSshInvocationKinds(systemSshInvocationLogPath)).not.toContain('forward')
      }

      await releaseSshPortForwardSnapshotBarrier(electronApp)
      const postHydrationRoundTripForwards = await mcodePage.evaluate(
        (targetId) => window.api.ssh.listPortForwards({ targetId }),
        remote.targetId
      )
      expect(postHydrationRoundTripForwards).toContainEqual(
        expect.objectContaining({ localPort, remotePort: REMOTE_PORT })
      )
      await expect(mcodePage.getByText(`:${REFRESH_BARRIER_PORT}`, { exact: true })).toBeVisible()
      const staleSnapshotEvidence = await readPortForwardEvidence(mcodePage, remote.targetId)
      const staleSnapshotIdentity = readRemoteListenerIdentity(target, REMOTE_PORT)
      const staleSnapshotWarnings = await readLifecycleWarnings(electronApp)
      expect(staleSnapshotEvidence.managerForwards).toContainEqual(
        expect.objectContaining({ localPort, remotePort: REMOTE_PORT })
      )
      expect(staleSnapshotEvidence.persistedForwards).toContainEqual(
        expect.objectContaining({ localPort, remotePort: REMOTE_PORT })
      )
      await expect(requestForward(localPort)).resolves.toContain(marker)
      expect(staleSnapshotIdentity).toMatchObject({
        pid: remotePid,
        executable: expect.stringContaining('/node'),
        command: expect.stringContaining(String(REMOTE_PORT))
      })
      expect(staleSnapshotWarnings.filter((message) => message.includes('Port forward'))).toEqual(
        []
      )
      await expect(
        mcodePage.getByText(`:${localPort} → :${REMOTE_PORT}`, { exact: true })
      ).toBeVisible()
      await expectForwardEvidence(mcodePage, remote.targetId, [
        { localPort, remotePort: REMOTE_PORT }
      ])
      await restoreSshPortForwardSnapshotHandler(electronApp)

      startRemoteHttpListener(target, SCAN_REFRESH_PORT, `${marker}_SCAN_REFRESH`)
      await expect
        .poll(
          () =>
            mcodePage.evaluate(
              ({ targetId, port }) =>
                window.api.ssh
                  .listDetectedPorts({ targetId })
                  .then((ports) => ports.some((entry) => entry.port === port)),
              { targetId: remote.targetId, port: SCAN_REFRESH_PORT }
            ),
          { timeout: 45_000, message: 'scan-refresh listener was not detected in main' }
        )
        .toBe(true)
      await expect(mcodePage.getByText(`:${SCAN_REFRESH_PORT}`, { exact: true })).toBeVisible()

      await unrelatedLocalPortReservation.release()
      const unrelatedForward = await addPortForward(mcodePage, {
        targetId: remote.targetId,
        localPort: unrelatedLocalPort,
        remotePort: REFRESH_BARRIER_PORT,
        label: 'unrelated-listener'
      })
      await expectForwardEvidence(mcodePage, remote.targetId, [
        { localPort, remotePort: REMOTE_PORT },
        { localPort: unrelatedLocalPort, remotePort: REFRESH_BARRIER_PORT }
      ])
      await expect.poll(() => requestForward(unrelatedLocalPort)).toContain(unrelatedMarker)

      await forceDockerSshRelayChannelReconnect(mcodePage, target, remote.targetId)
      await expectForwardEvidence(mcodePage, remote.targetId, [
        { localPort, remotePort: REMOTE_PORT },
        { localPort: unrelatedLocalPort, remotePort: REFRESH_BARRIER_PORT }
      ])
      await expect.poll(() => requestForward(localPort)).toContain(marker)
      await expect.poll(() => requestForward(unrelatedLocalPort)).toContain(unrelatedMarker)

      const authorityBeforeTransportReconnect = await mcodePage.evaluate(
        (targetId) => window.__store?.getState().sshConnectionStates.get(targetId),
        remote.targetId
      )
      await reconnectDockerSshRelayTarget(mcodePage, remote.targetId)
      await expect
        .poll(
          async () => {
            const state = await mcodePage.evaluate(
              (targetId) => window.__store?.getState().sshConnectionStates.get(targetId),
              remote.targetId
            )
            return (
              state?.status === 'connected' &&
              (state.providerEpoch !== authorityBeforeTransportReconnect?.providerEpoch ||
                state.connectionGeneration !==
                  authorityBeforeTransportReconnect?.connectionGeneration)
            )
          },
          { timeout: 30_000, message: 'renderer did not observe the reconnected SSH authority' }
        )
        .toBe(true)
      await expectForwardEvidence(mcodePage, remote.targetId, [
        { localPort, remotePort: REMOTE_PORT },
        { localPort: unrelatedLocalPort, remotePort: REFRESH_BARRIER_PORT }
      ])
      await expect.poll(() => requestForward(localPort)).toContain(marker)
      await expect.poll(() => requestForward(unrelatedLocalPort)).toContain(unrelatedMarker)
      await expect(
        mcodePage.getByText(`:${localPort} → :${REMOTE_PORT}`, { exact: true })
      ).toBeVisible()
      await expect(
        mcodePage.getByText(`:${unrelatedLocalPort} → :${REFRESH_BARRIER_PORT}`, { exact: true })
      ).toBeVisible()

      const collisionServer = createServer()
      await new Promise<void>((resolve, reject) => {
        collisionServer.once('error', reject)
        collisionServer.listen(0, '127.0.0.1', resolve)
      })
      const collisionAddress = collisionServer.address()
      if (!collisionAddress || typeof collisionAddress === 'string') {
        throw new Error('Unable to reserve a collision port')
      }
      try {
        const collisionResult = await mcodePage.evaluate(
          async ({ targetId, localPort, remotePort }) => {
            try {
              await window.api.ssh.addPortForward({
                targetId,
                localPort,
                remoteHost: '127.0.0.1',
                remotePort,
                label: 'collision'
              })
              return { ok: true, message: '' }
            } catch (error) {
              return { ok: false, message: error instanceof Error ? error.message : String(error) }
            }
          },
          {
            targetId: remote.targetId,
            localPort: collisionAddress.port,
            remotePort: REMOTE_PORT
          }
        )
        expect(collisionResult).toMatchObject({ ok: false })
        expect(collisionResult.message).toMatch(/in use|EADDRINUSE/i)
      } finally {
        await new Promise<void>((resolve, reject) =>
          collisionServer.close((error) => (error ? reject(error) : resolve()))
        )
      }
      await expectForwardEvidence(mcodePage, remote.targetId, [
        { localPort, remotePort: REMOTE_PORT },
        { localPort: unrelatedLocalPort, remotePort: REFRESH_BARRIER_PORT }
      ])

      const primaryRow = mcodePage
        .getByText(`:${localPort} → :${REMOTE_PORT}`, { exact: true })
        .locator('../../..')
      await primaryRow.getByTitle('Remove').click()
      await expect(
        mcodePage.getByText(`:${localPort} → :${REMOTE_PORT}`, { exact: true })
      ).not.toBeVisible()
      await expectForwardEvidence(mcodePage, remote.targetId, [
        { localPort: unrelatedLocalPort, remotePort: REFRESH_BARRIER_PORT }
      ])
      await expect(requestForward(localPort)).rejects.toThrow()
      await expect.poll(() => requestForward(unrelatedLocalPort)).toContain(unrelatedMarker)

      const evidence = await readPortForwardEvidence(mcodePage, remote.targetId)
      const identity = readRemoteListenerIdentity(target, REMOTE_PORT)
      const unrelatedIdentity = readRemoteListenerIdentity(target, REFRESH_BARRIER_PORT)
      const warnings = await readLifecycleWarnings(electronApp)
      const relayReconnectStates = await readSshStateCapture(mcodePage)
      testInfo.annotations.push({
        type: 'ssh-port-forward-evidence',
        description: JSON.stringify({
          evidence,
          identity,
          unrelatedIdentity,
          removedForwardLocalPort: localPort,
          unrelatedForward,
          relayReconnectStates,
          staleSnapshotEvidence,
          systemSshInvocations: readSystemSshInvocationKinds(systemSshInvocationLogPath),
          warnings
        })
      })

      expect(identity).toMatchObject({
        pid: remotePid,
        executable: expect.stringContaining('/node'),
        command: expect.stringContaining(String(REMOTE_PORT))
      })
      expect(unrelatedIdentity).toMatchObject({
        pid: unrelatedRemotePid,
        executable: expect.stringContaining('/node'),
        command: expect.stringContaining(String(REFRESH_BARRIER_PORT))
      })
      expect(evidence.rendererForwards).not.toContainEqual(
        expect.objectContaining({ localPort, remotePort: REMOTE_PORT })
      )
      expect(evidence.managerForwards).not.toContainEqual(
        expect.objectContaining({ localPort, remotePort: REMOTE_PORT })
      )
      expect(evidence.persistedForwards).not.toContainEqual(
        expect.objectContaining({ localPort, remotePort: REMOTE_PORT })
      )
      expect(evidence.events.at(-1)?.forwards).toContainEqual(
        expect.objectContaining({
          localPort: unrelatedLocalPort,
          remotePort: REFRESH_BARRIER_PORT
        })
      )
      await expect(requestForward(unrelatedLocalPort)).resolves.toContain(unrelatedMarker)
      expect(warnings.filter((message) => message.includes('Port forward'))).toEqual([])
    } finally {
      await restoreSshPortForwardSnapshotHandler(electronApp).catch(() => undefined)
      await restoreLifecycleWarningCapture(electronApp).catch(() => undefined)
      await localPortReservation.release().catch(() => undefined)
      await unrelatedLocalPortReservation.release().catch(() => undefined)
      cleanupDockerSshRelayTarget(target)
    }
  })
})
