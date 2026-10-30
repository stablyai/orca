// #29059: two Docker machines sharing /root must keep independent managed servers and records across reconnect.
// Host B must not judge A’s recorded PID in its own namespace; use ORCA_E2E_ORCAD_CONVERT_TEMPLATE for linux-x64-glibc.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { reconnect } from './helpers/orcad-convert-flow'
import { ORCAD_CONVERT_HOST_ENV } from './helpers/orcad-convert-host'
import {
  cleanupDockerSshHostTarget,
  execDockerSshHostTargetCommand,
  startDockerSshHostTarget,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
const LOGIN_HOME_SLOTS = '/root/.orca-remote/orcad-*/.orcad-pid'
const MACHINE_HOME_SLOTS = '/root/.orca-remote/hosts/*/.orca-remote/orcad-*/.orcad-pid'

// Require recorded PID command lines to match the slot in this container; another namespace can reuse that PID.
function runningPids(target: DockerSshHostTarget, pattern: string): string[] {
  return execDockerSshHostTargetCommand(
    target,
    `for f in ${pattern}; do pid=$(cat "$f" 2>/dev/null) && ` +
      'kill -0 "$pid" 2>/dev/null && ' +
      `tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -qF "$(dirname "$f")/" && ` +
      'echo "$pid"; done; true'
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function recordedPids(target: DockerSshHostTarget, pattern: string): string {
  return execDockerSshHostTargetCommand(target, `cat ${pattern} 2>/dev/null; true`).trim()
}

test('machines sharing one home each run their own managed server', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its isolated app and hosts.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(15 * 60_000)
  const volume = `orca-e2e-shared-home-${randomUUID().slice(0, 8)}`
  execFileSync('docker', ['volume', 'create', volume], {
    stdio: 'ignore',
    timeout: 30_000
  })
  let hostA: DockerSshHostTarget | null = null
  let hostB: DockerSshHostTarget | null = null
  const session = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE!
  })
  let app: ElectronApplication | null = null
  try {
    hostA = startDockerSshHostTarget(testInfo, { sharedHomeVolume: volume })
    hostB = startDockerSshHostTarget(testInfo, { sharedHomeVolume: volume })
    const launched = await session.launch()
    app = launched.app
    const { page } = launched
    await waitForSessionReady(page)

    const a = await connectManagedHost(page, hostA, 'A')
    expect(runningPids(hostA, LOGIN_HOME_SLOTS)).toHaveLength(1)
    const aRecorded = recordedPids(hostA, LOGIN_HOME_SLOTS)

    const b = await connectManagedHost(page, hostB, 'B')
    expect(b.environmentId).not.toBe(a.environmentId)
    expect(runningPids(hostB, MACHINE_HOME_SLOTS)).toHaveLength(1)
    // B never launched into A's slots, and A's server still runs on its own record.
    expect(runningPids(hostB, LOGIN_HOME_SLOTS)).toEqual([])
    expect(recordedPids(hostA, LOGIN_HOME_SLOTS)).toBe(aRecorded)
    expect(runningPids(hostA, LOGIN_HOME_SLOTS)).toHaveLength(1)

    for (const [host, slots] of [
      [a, LOGIN_HOME_SLOTS],
      [b, MACHINE_HOME_SLOTS]
    ] as const) {
      expect(JSON.parse(await reconnect(page, host.targetId))).toMatchObject({
        kind: 'managed'
      })
      await expect
        .poll(() => terminalListOk(page, host.environmentId), {
          timeout: 60_000
        })
        .toBe(true)
      expect(runningPids(host === a ? hostA : hostB, slots)).toHaveLength(1)
    }
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshHostTarget(hostA)
    cleanupDockerSshHostTarget(hostB)
    spawnSync('docker', ['volume', 'rm', '-f', volume], {
      stdio: 'ignore',
      timeout: 30_000
    })
  }
})

async function connectManagedHost(
  page: Page,
  target: DockerSshHostTarget,
  name: string
): Promise<{ targetId: string; environmentId: string }> {
  const connected = await page.evaluate(
    async (input) => {
      const { target: created } = await window.api.ssh.addTarget({
        target: input
      })
      const state = await window.api.ssh.connect({ targetId: created.id })
      return {
        targetId: created.id,
        managedServer: state?.managedServer ?? null
      }
    },
    {
      label: `orcad shared home ${name} ${Date.now()}`,
      host: target.host,
      port: target.port,
      username: 'root',
      identityFile: target.identityFile,
      identitiesOnly: true,
      relayGracePeriodSeconds: 1
    }
  )
  const server = connected.managedServer
  if (server?.kind !== 'managed') {
    throw new Error(`host ${name}: expected a managed server, got ${JSON.stringify(server)}`)
  }
  return { targetId: connected.targetId, environmentId: server.environmentId }
}

async function terminalListOk(page: Page, environmentId: string): Promise<boolean> {
  return page.evaluate(async (selector) => {
    const response = await window.api.runtimeEnvironments.call({
      selector,
      method: 'terminal.list',
      params: {}
    })
    return response.ok
  }, environmentId)
}
