// Recover real managed orcad after idle exit, kill/reboot and stale active-slot records on a fresh desktop (#27284).
// Reuse surviving daemon PTYs after kill; start fresh after reboot and consume idle-stop records.
// Docker only: ORCA_E2E_ORCAD_CONVERT_TEMPLATE must be linux-x64-glibc; forward a short test quiet period.
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { reconnect } from './helpers/orcad-convert-flow'
import { ORCAD_CONVERT_HOST_ENV } from './helpers/orcad-convert-host'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  execDockerSshHostTargetCommand,
  startDockerSshHostTarget,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import { ORCAD_E2E_IDLE_TIMEOUT_ENV } from '../../src/shared/orcad-idle-exit'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
// Long enough that a connected client's own traffic never lets it lapse mid-test.
const IDLE_TIMEOUT_MS = 15_000
const RECORD = '/root/.orca/orcad-idle-stop.json'

/** PIDs of running orcad slots; empty once every slot has exited. */
function runningOrcadPids(target: DockerSshHostTarget): string[] {
  return execDockerSshHostTargetCommand(
    target,
    'for f in /root/.orca-remote/orcad-*/.orcad-pid; do pid=$(cat "$f" 2>/dev/null) && ' +
      'kill -0 "$pid" 2>/dev/null && echo "$pid"; done; true'
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function readIdleStopRecord(target: DockerSshHostTarget): unknown {
  const raw = execDockerSshHostTargetCommand(target, `cat ${RECORD} 2>/dev/null || true`).trim()
  return raw ? JSON.parse(raw) : null
}

test('a managed orcad stops after idling and starts again on the next connect', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(15 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
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
    const remote = await connectManagedHost(first.page, target)
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
          execDockerSshHostTargetCommand(target, 'tail -n 40 /root/.orca-remote/orcad-*/orcad.log')
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
    await expect
      .poll(
        async () =>
          (await callEnvironment(second.page, remote.environmentId, 'terminal.list', {})).ok,
        { timeout: 60_000 }
      )
      .toBe(true)
    expect(runningOrcadPids(target)).toHaveLength(1)
    // The restarted server read the record, so a later crash cannot be mistaken for an idle stop.
    expect(readIdleStopRecord(target)).toBeNull()
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshHostTarget(target)
  }
})

async function connectManagedHost(
  page: Page,
  target: DockerSshHostTarget
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
function processAlive(target: DockerSshHostTarget, marker: string): boolean {
  const found = execDockerSshHostTargetCommand(
    target,
    `pgrep -f '[s]leep ${marker}' >/dev/null && echo yes || true`
  )
  return found.trim() === 'yes'
}

test('a live managed process that does not answer remains unverifiable', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its isolated app and host.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    'Requires the owned Docker SSH host and template'
  )
  test.setTimeout(5 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  let pausedPid: string | null = null
  try {
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    const { targetId, environmentId } = await connectManagedHost(page, target)
    await page.evaluate((targetId) => window.api.ssh.disconnect({ targetId }), targetId)
    const pids = runningOrcadPids(target)
    expect(pids).toHaveLength(1)
    const pid = pids[0]
    expect(pid).toMatch(/^\d+$/)
    execDockerSshHostTargetCommand(target, `kill -STOP ${pid}`)
    pausedPid = pid
    const held = await page.evaluate((targetId) => window.api.ssh.connect({ targetId }), targetId)
    console.log(
      '[managed-live-process] held',
      JSON.stringify({ held, pids: runningOrcadPids(target) })
    )
    expect(runningOrcadPids(target)).toEqual([pid])
    expect(held?.managedServer).toMatchObject({
      kind: 'managed',
      environmentId,
      serving: { state: 'unverifiable' }
    })
    execDockerSshHostTargetCommand(target, `kill -CONT ${pid}`)
    pausedPid = null
    const recovered = JSON.parse(await reconnect(page, targetId))
    console.log(
      '[managed-live-process] recovered',
      JSON.stringify({ recovered, pids: runningOrcadPids(target) })
    )
    expect(recovered).toMatchObject({ kind: 'managed', environmentId })
    expect(recovered).not.toHaveProperty('serving')
    expect(await callEnvironment(page, environmentId, 'terminal.list', {})).toMatchObject({
      ok: true
    })
    expect(runningOrcadPids(target)).toEqual([pid])
  } finally {
    if (pausedPid) {
      execDockerSshHostTargetCommand(target, `kill -CONT ${pausedPid}`)
    }
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshHostTarget(target)
  }
})

test('a killed managed orcad comes back with its terminal, and starts fresh after a reboot', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(15 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
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
        path: DOCKER_SSH_HOST_REMOTE_REPO_PATH
      })
    ).toMatchObject({ ok: true })
    expect(
      await callEnvironment(page, environmentId, 'terminal.create', {
        worktree: `path:${DOCKER_SSH_HOST_REMOTE_REPO_PATH}`,
        command: `exec sleep ${marker}`
      })
    ).toMatchObject({ ok: true })
    await expect.poll(() => processAlive(target, marker), { timeout: 60_000 }).toBe(true)

    // Killed: the daemon keeps the terminal, and the next call starts orcad, which adopts it.
    execDockerSshHostTargetCommand(
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
    execDockerSshHostTargetCommand(target, "pkill -KILL -f '/root/[.]orca-remote/' || true")
    execDockerSshHostTargetCommand(target, `pkill -KILL -f '[s]leep ${marker}' || true`)
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
    cleanupDockerSshHostTarget(target)
  }
})

// Slim images ship no ps, and after a reboot the slot's recorded PID often names a new process (#34149).
test('after a reboot on a host without ps, a recycled server PID does not keep the server down', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its isolated app and host.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  // Deploys a real server, then reconnects after a simulated reboot.
  test.setTimeout(10 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  try {
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    const { targetId, environmentId } = await connectManagedHost(page, target)
    await page.evaluate((targetId) => window.api.ssh.disconnect({ targetId }), targetId)

    execDockerSshHostTargetCommand(target, "pkill -KILL -f '/root/[.]orca-remote/' || true")
    await expect.poll(() => runningOrcadPids(target), { timeout: 60_000 }).toEqual([])
    const marker = String(800_000 + Math.floor(Math.random() * 100_000))
    // The stale pid file now names a live process of the same user that is not orcad.
    execDockerSshHostTargetCommand(
      target,
      `setsid sleep ${marker} </dev/null >/dev/null 2>&1 & ` +
        'for f in /root/.orca-remote/orcad-*/.orcad-pid; do echo $! > "$f"; done; ' +
        'mv "$(command -v ps)" /usr/local/ps-hidden'
    )
    await expect.poll(() => processAlive(target, marker), { timeout: 10_000 }).toBe(true)

    const connected = JSON.parse(await reconnect(page, targetId))
    expect(connected).toMatchObject({ kind: 'managed', environmentId })
    expect(connected).not.toHaveProperty('serving')
    expect(await callEnvironment(page, environmentId, 'terminal.list', {})).toMatchObject({
      ok: true
    })
    expect(processAlive(target, marker)).toBe(true)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    cleanupDockerSshHostTarget(target)
  }
})

test('a new desktop on the same build starts a server that was killed with its daemon', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(
    HOST !== 'docker' || !TEMPLATE_SOURCE,
    `Set ${ORCAD_CONVERT_HOST_ENV}=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
  test.setTimeout(10 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const env = { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! }
  const deployer = createRestartSession(testInfo, env)
  // Its own profile: it has never registered this host, so its connect runs the deploy.
  const newcomer = createRestartSession(testInfo, env)
  let app: ElectronApplication | null = null
  let appSession = deployer
  try {
    const first = await deployer.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await connectManagedHost(first.page, target)
    await deployer.close(app)
    app = null

    // Killed outside Orca, as after a reboot: the activation record still names the slot.
    execDockerSshHostTargetCommand(target, "pkill -KILL -f '/root/[.]orca-remote/' || true")
    await expect.poll(() => runningOrcadPids(target), { timeout: 60_000 }).toEqual([])

    appSession = newcomer
    const second = await newcomer.launch()
    app = second.app
    await waitForSessionReady(second.page)
    const { environmentId } = await connectManagedHost(second.page, target)
    expect(runningOrcadPids(target)).toHaveLength(1)
    expect(await callEnvironment(second.page, environmentId, 'terminal.list', {})).toMatchObject({
      ok: true
    })
  } finally {
    if (app) {
      await appSession.close(app)
    }
    await deployer.dispose()
    await newcomer.dispose()
    cleanupDockerSshHostTarget(target)
  }
})
