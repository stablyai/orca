import type { Page } from '@stablyai/playwright-test'
import type { PairedElectronClient } from './paired-electron-client'
import type { DockerSshRelayTarget } from './docker-ssh-relay-target'
import {
  reconnectDisconnectedDockerSshRelayTarget,
  resetDockerSshRelayTarget
} from './docker-ssh-relay-connection'
import {
  isDockerSshRelayPidRunning,
  readDockerSshRelayProcessSnapshots,
  terminateDockerSshRelay,
  type DockerSshRelayProcessSnapshot
} from './docker-ssh-relay-processes'
import { assertRuntimeSshStatus } from './nested-runtime-ssh-state'
import { expect } from './orca-app'

type NestedRelayRoute = {
  label: string
  target: DockerSshRelayTarget
  targetId: string
}

async function stopRelayProcesses(
  route: NestedRelayRoute
): Promise<DockerSshRelayProcessSnapshot[]> {
  const processes = readDockerSshRelayProcessSnapshots(route.target)
  expect(
    processes.length,
    `${route.label} destination has no detached relay`
  ).toBeGreaterThanOrEqual(1)
  for (const process of processes) {
    terminateDockerSshRelay(route.target, process)
  }
  await expect
    .poll(() =>
      processes.every((process) => !isDockerSshRelayPidRunning(route.target, process.relayPid))
    )
    .toBe(true)
  return processes
}

async function assertRelayProcessesReplaced(
  route: NestedRelayRoute,
  previous: DockerSshRelayProcessSnapshot[]
): Promise<void> {
  await expect
    .poll(() => {
      const currentPids = new Set(
        readDockerSshRelayProcessSnapshots(route.target).map((process) => process.relayPid)
      )
      return (
        currentPids.size >= 1 && previous.every((process) => !currentPids.has(process.relayPid))
      )
    })
    .toBe(true)
}

export async function restartProxyJumpDetachedRelay(
  hubPage: Page,
  direct: NestedRelayRoute,
  proxyJump: NestedRelayRoute,
  clients: readonly PairedElectronClient[]
): Promise<void> {
  // Why: direct ssh2 owns an attached relay channel; only system-SSH ProxyJump leaves a detached daemon.
  expect(readDockerSshRelayProcessSnapshots(direct.target)).toEqual([])
  const proxyJumpProcesses = await stopRelayProcesses(proxyJump)

  // Why: detached relay replacement is an explicit HUB lifecycle operation, separate from nested owner routing.
  await resetDockerSshRelayTarget(hubPage, proxyJump.targetId)
  for (const client of clients) {
    await assertRuntimeSshStatus(client, direct.targetId, 'connected')
    await assertRuntimeSshStatus(client, proxyJump.targetId, 'disconnected')
  }

  await reconnectDisconnectedDockerSshRelayTarget(hubPage, proxyJump.targetId)
  for (const client of clients) {
    await assertRuntimeSshStatus(client, direct.targetId, 'connected')
    await assertRuntimeSshStatus(client, proxyJump.targetId, 'connected')
  }

  expect(readDockerSshRelayProcessSnapshots(direct.target)).toEqual([])
  await assertRelayProcessesReplaced(proxyJump, proxyJumpProcesses)
}
