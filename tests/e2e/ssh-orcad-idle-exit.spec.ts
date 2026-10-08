/**
 * A managed orcad that stops is started again by the client, on a real host:
 *
 * 1. Idle: quit the client, the server exits and records an idle stop; a relaunched client
 *    reconnects and the server is running again with that record consumed.
 * 2. Killed, then a reboot: a killed server comes back on the next call and adopts the daemon
 *    that kept its terminal; once both are gone, the next connect starts fresh.
 *
 * Docker only. `ORCA_E2E_ORCAD_CONVERT_TEMPLATE` names the linux-x64-glibc orcad build, and the
 * client forwards a short test-only quiet period to the server it launches.
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { reconnect } from './helpers/orcad-convert-flow'
import { ORCAD_CONVERT_HOST_ENV } from './helpers/orcad-convert-host'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { ORCAD_E2E_IDLE_TIMEOUT_ENV } from '../../src/shared/orcad-idle-exit'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
// Long enough that a connected client's own traffic never lets it lapse mid-test.
const IDLE_TIMEOUT_MS = 15_000
const RECORD = '/root/.orca/orcad-idle-stop.json'

/** PIDs of running orcad slots; empty once every slot has exited. */
function runningOrcadPids(target: DockerSshRelayTarget): string[] {
  return execDockerSshRelayTargetCommand(
    target,
    'for f in /root/.orca-remote/orcad-*/.orcad-pid; do pid=$(cat "$f" 2>/dev/null) && ' +
      'kill -0 "$pid" 2>/dev/null && echo "$pid"; done; true'
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function readIdleStopRecord(target: DockerSshRelayTarget): unknown {
  const raw = execDockerSshRelayTargetCommand(target, `cat ${RECORD} 2>/dev/null || true`).trim()
  return raw ? JSON.parse(raw) : null
}

test('a managed orcad stops after idling and starts again on the next connect', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(15 * 60_000)
  const target = startDockerSshRelayTarget(testInfo)
  const session = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE!,
    [ORCAD_E2E_IDLE_TIMEOUT_ENV]: String(IDLE_TIMEOUT_MS)
  })
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    // A managed host is reached through its server, not a relay, so no relay repo is added.
    const remote = await first.page.evaluate(
      async (input) => {
        const { target: created } = await window.api.ssh.addTarget({ target: input })
        const state = await window.api.ssh.connect({ targetId: created.id })
        return { targetId: created.id, managedServer: state?.managedServer ?? null }
      },
      {
        label: `orcad idle E2E ${Date.now()}`,
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      }
    )
    expect(remote.managedServer).toMatchObject({ kind: 'managed' })
    expect(runningOrcadPids(target)).toHaveLength(1)

    // While the client is connected the server stays up past its quiet period.
    await first.page.waitForTimeout(IDLE_TIMEOUT_MS * 2)
    expect(runningOrcadPids(target)).toHaveLength(1)

    await session.close(app)
    app = null
    await expect
      .poll(() => runningOrcadPids(target), { timeout: 3 * 60_000 })
      .toEqual([])
      .catch((error: unknown) => {
        // The server logs what kept it up; without it a timeout explains nothing.
        console.error(
          execDockerSshRelayTargetCommand(target, 'tail -n 40 /root/.orca-remote/orcad-*/orcad.log')
        )
        throw error
      })
    expect(readIdleStopRecord(target)).toMatchObject({
      kind: 'orcad_idle_stop',
      idleTimeoutMs: IDLE_TIMEOUT_MS
    })

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    const connected = await reconnect(second.page, remote.targetId)
    // A start inherited from the launch-time connect this reconnect dropped would report `serving`.
    expect(JSON.parse(connected)).toMatchObject({ kind: 'managed' })
    expect(JSON.parse(connected)).not.toHaveProperty('serving')
    expect(runningOrcadPids(target)).toHaveLength(1)
    // The restarted server read the record, so a later crash cannot be mistaken for an idle stop.
    expect(readIdleStopRecord(target)).toBeNull()
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})

async function connectManagedHost(
  page: Page,
  target: DockerSshRelayTarget
): Promise<{ targetId: string; environmentId: string }> {
  const connected = await page.evaluate(
    async (input) => {
      const { target: created } = await window.api.ssh.addTarget({ target: input })
      const state = await window.api.ssh.connect({ targetId: created.id })
      return { targetId: created.id, managedServer: state?.managedServer ?? null }
    },
    {
      label: `orcad restart E2E ${Date.now()}`,
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
    throw new Error(`expected a managed server, got ${JSON.stringify(server)}`)
  }
  return { targetId: connected.targetId, environmentId: server.environmentId }
}

async function callEnvironment(page: Page, environmentId: string, method: string, params: unknown) {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      return response.ok ? { ok: true as const } : { ok: false as const, error: response.error }
    },
    { environmentId, method, params }
  )
}

/** The bracket keeps pgrep from matching the shell that runs it. */
function processAlive(target: DockerSshRelayTarget, marker: string): boolean {
  const found = execDockerSshRelayTargetCommand(
    target,
    `pgrep -f '[s]leep ${marker}' >/dev/null && echo yes || true`
  )
  return found.trim() === 'yes'
}

test('a killed managed orcad comes back with its terminal, and starts fresh after a reboot', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(15 * 60_000)
  const target = startDockerSshRelayTarget(testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  try {
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    const { targetId, environmentId } = await connectManagedHost(page, target)
    // A unique sleep length is the terminal's fingerprint in the process table.
    const marker = String(800_000 + Math.floor(Math.random() * 100_000))
    expect(
      await callEnvironment(page, environmentId, 'repo.add', {
        path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
      })
    ).toMatchObject({ ok: true })
    expect(
      await callEnvironment(page, environmentId, 'terminal.create', {
        worktree: `path:${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}`,
        command: `exec sleep ${marker}`
      })
    ).toMatchObject({ ok: true })
    await expect.poll(() => processAlive(target, marker), { timeout: 60_000 }).toBe(true)

    // Killed: the daemon keeps the terminal, and the next call starts orcad, which adopts it.
    execDockerSshRelayTargetCommand(
      target,
      'kill -TERM $(cat /root/.orca-remote/orcad-*/.orcad-pid)'
    )
    await expect.poll(() => runningOrcadPids(target), { timeout: 60_000 }).toEqual([])
    expect(processAlive(target, marker)).toBe(true)
    await expect
      .poll(async () => (await callEnvironment(page, environmentId, 'terminal.list', {})).ok, {
        timeout: 3 * 60_000
      })
      .toBe(true)
    expect(runningOrcadPids(target)).toHaveLength(1)
    expect(processAlive(target, marker)).toBe(true)

    // A reboot takes orcad, the daemon and its terminal; the next connect starts both fresh.
    execDockerSshRelayTargetCommand(target, "pkill -KILL -f '/root/[.]orca-remote/' || true")
    execDockerSshRelayTargetCommand(target, `pkill -KILL -f '[s]leep ${marker}' || true`)
    await expect.poll(() => runningOrcadPids(target), { timeout: 60_000 }).toEqual([])
    const connected = JSON.parse(await reconnect(page, targetId))
    expect(connected).toMatchObject({ kind: 'managed', environmentId })
    expect(connected).not.toHaveProperty('serving')
    expect(runningOrcadPids(target)).toHaveLength(1)
    expect(processAlive(target, marker)).toBe(false)
    expect(await callEnvironment(page, environmentId, 'terminal.list', {})).toMatchObject({
      ok: true
    })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})
