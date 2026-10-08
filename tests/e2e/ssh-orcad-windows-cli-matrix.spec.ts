/**
 * The bundled `orca` CLI against a real Windows OpenSSH host running managed orcad, one cell per
 * test (config/ci/windows-ssh-provider/invoke-pinned-relay-cells.ps1 greps by tag):
 *
 * - `@orcad-cli-managed`: an empty host deploys; `host list`/`environment list|show` name it; a CLI
 *   terminal survives disconnect/reconnect; `environment rm` refuses a managed server, the stop
 *   decommissions it and cleans the host, and the next connect redeploys; last, a hard orcad restart
 *   reads unverifiable then live, never retired.
 * - `@orcad-cli-convert`: a seeded relay-era profile converts, keeps then retires its source, and the
 *   CLI reaches the converted server's projects.
 * - `@orcad-cli-relay-kept`: an open relay terminal keeps the host on the relay with its status line;
 *   once the CLI closes it, the next connect converts.
 *
 * Host: `ORCA_E2E_ORCAD_CONVERT_HOST`, a Windows host-cell descriptor. Template:
 * `ORCA_E2E_ORCAD_CONVERT_TEMPLATE`, built for that host's target.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { connectSshTestTarget } from './helpers/ssh-test-target-connection'
import { createRestartSession } from './helpers/orca-restart'
import {
  convertThenRetire,
  managedServer,
  reconnect,
  targetLeases
} from './helpers/orcad-convert-flow'
import { seedRelayEraProfile, seedRelayEraTarget } from './helpers/orcad-upgrade-profile'
import { ORCAD_CONVERT_HOST_ENV, startOrcadConvertHost } from './helpers/orcad-convert-host'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { orcaCliResult, runCompiledOrcaCli } from './helpers/compiled-orca-cli'
import {
  killHostOrcad,
  listHostOrcadProcesses,
  listHostOrcadServerProcesses
} from './helpers/windows-host-orcad-processes'
import { readWindowsHostCellDescriptor } from '../../src/main/ssh/ssh-windows-host-cells'
import { runtimeHostContactFromSnapshot } from '../../src/shared/runtime-host-contact'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead
} from '../../src/shared/runtime-terminal-contracts'

const HOST = process.env[ORCAD_CONVERT_HOST_ENV]
const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
const SCRATCH = path.join(os.tmpdir(), `orca-orcad-cli-matrix-${process.pid}`)
const FLAGS_FILE = path.join(SCRATCH, 'rollout-flags.json')
const MANAGED_TIMEOUT_MS = 8 * 60_000

type HostRow = {
  kind: string
  id: string
  connected?: boolean
  platform?: string
}
type EnvironmentRow = { id: string; name: string }

function skipUnlessWindowsHost(): void {
  test.skip(
    !HOST || !TEMPLATE || HOST === 'docker',
    `Set ${ORCAD_CONVERT_HOST_ENV} to a Windows host-cell descriptor and ORCA_E2E_ORCAD_CONVERT_TEMPLATE`
  )
}

function resetScratch(): void {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  writeFileSync(FLAGS_FILE, '{}')
}

function launchEnv(): Record<string, string> {
  return {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE!,
    ORCA_E2E_ROLLOUT_FLAGS_FILE: FLAGS_FILE
  }
}

/** Keeps the app's SSH lines in the test output, so a failed connect explains itself. */
function sshStderr(chunk: string): void {
  if (chunk.includes('[ssh]') || chunk.includes('orcad')) {
    process.stderr.write(chunk)
  }
}

/** A Windows profile a crashed launch still holds must not replace the test's own failure. */
async function disposeQuietly(session: { dispose: () => Promise<void> }): Promise<void> {
  try {
    await session.dispose()
  } catch (error) {
    console.warn('[e2e] Restart profile cleanup failed:', error)
  }
}

/** Windows can keep the just-closed app's SQLite file busy for a moment ("disk I/O error"). */
async function mutateStoppedProfileStateWhenReleased(
  userDataDir: string,
  mutate: (state: Record<string, unknown>) => void
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      mutateStoppedProfileState(userDataDir, mutate)
      return
    } catch (error) {
      if (attempt >= 10) {
        throw error
      }
      console.log(`[cli-matrix] stopped profile busy (attempt ${attempt}): ${String(error)}`)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}

async function waitForManaged(page: Page, targetId: string): Promise<string> {
  let environmentId = ''
  await expect
    .poll(
      async () => {
        const server = await managedServer(page, targetId)
        if (server && typeof server === 'object' && 'environmentId' in server) {
          environmentId = String(server.environmentId)
          return 'managed'
        }
        return JSON.stringify(server)
      },
      { timeout: MANAGED_TIMEOUT_MS }
    )
    .toBe('managed')
  return environmentId
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
  return normalize(left) === normalize(right)
}

async function hostRows(userData: string): Promise<HostRow[]> {
  return (await orcaCliResult<{ hosts: HostRow[] }>(userData, ['host', 'list'])).hosts
}

async function environmentIds(userData: string): Promise<string[]> {
  const listed = await orcaCliResult<{ environments: EnvironmentRow[] }>(userData, [
    'environment',
    'list'
  ])
  return listed.environments.map((entry) => entry.id)
}

async function readTerminal(
  userData: string,
  environmentId: string,
  handle: string
): Promise<RuntimeTerminalRead> {
  return (
    await orcaCliResult<{ terminal: RuntimeTerminalRead }>(userData, [
      'terminal',
      'read',
      '--environment',
      environmentId,
      '--terminal',
      handle,
      '--limit',
      '500'
    ])
  ).terminal
}

/** An echoed line on its own: the typed command line carries the prompt in front of it. */
async function waitForEchoedLine(
  userData: string,
  environmentId: string,
  handle: string,
  marker: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const read = await readTerminal(userData, environmentId, handle)
        return read.tail.some((line) => line.trim() === marker)
          ? 'echoed'
          : `${read.status}: ${read.tail.slice(-6).join(' | ')}`
      },
      { timeout: 60_000 }
    )
    .toBe('echoed')
}

async function sendLine(
  userData: string,
  environmentId: string,
  handle: string,
  text: string
): Promise<void> {
  await orcaCliResult(userData, [
    'terminal',
    'send',
    '--environment',
    environmentId,
    '--terminal',
    handle,
    '--text',
    text,
    '--enter'
  ])
}

/** Host Node is hidden on the lane, so the listener is Windows PowerShell's own TcpListener. */
// Why no `$`: the managed terminal's shell may be PowerShell, which would expand it before the child sees it.
// Why the trailing comment: Windows exposes no process cwd, so the scanner attributes by the
// worktree path in the listener's command line, as it does for `node <repo>\...\vite.js`.
const DETECTED_PORT = 4317

async function expectWorkspacePortDetected(
  page: Page,
  userData: string,
  environmentId: string,
  repoId: string,
  worktree: { id: string; path: string }
): Promise<void> {
  const worktreeId = worktree.id
  const listener = await orcaCliResult<{ terminal: { handle: string } }>(userData, [
    'terminal',
    'create',
    '--environment',
    environmentId,
    '--worktree',
    `id:${worktreeId}`,
    '--title',
    'port-listener'
  ])
  await sendLine(
    userData,
    environmentId,
    listener.terminal.handle,
    `powershell -NoProfile -Command "[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,${DETECTED_PORT}) | Tee-Object -Variable keep | ForEach-Object Start; Write-Output ORCA_PORT_LISTENING; Start-Sleep 900 # ${worktree.path}"`
  )
  await waitForEchoedLine(userData, environmentId, listener.terminal.handle, 'ORCA_PORT_LISTENING')
  let last = ''
  await expect
    .poll(
      async () => {
        const response = await page.evaluate((args) => window.api.runtimeEnvironments.call(args), {
          selector: environmentId,
          method: 'workspacePorts.scan',
          params: { repoId },
          timeoutMs: 30_000
        })
        last = JSON.stringify(response)
        const result =
          response.ok && response.result && typeof response.result === 'object'
            ? response.result
            : null
        const ports = result && 'ports' in result && Array.isArray(result.ports) ? result.ports : []
        const entry = ports.find((port: { port?: unknown }) => port?.port === DETECTED_PORT)
        if (entry) {
          last = JSON.stringify(entry)
        }
        return entry
          ? `${entry.kind}:${entry.owner?.worktreeId ?? ''}:${entry.owner?.confidence ?? ''}:${typeof entry.pid}`
          : 'absent'
      },
      { timeout: 90_000 }
    )
    .toBe(`workspace:${worktreeId}:command:number`)
    .catch((error: unknown) => {
      throw new Error(
        `workspacePorts.scan never attributed ${DETECTED_PORT}: ${last.slice(0, 3_000)}`,
        {
          cause: error
        }
      )
    })
  console.log(`[cli-matrix] workspace port detected: ${last.slice(0, 1_500)}`)
  await orcaCliResult(userData, [
    'terminal',
    'close',
    '--environment',
    environmentId,
    '--terminal',
    listener.terminal.handle
  ])
}

/** The terminal is still listed after an orcad restart, kept its output and still takes input. */
async function expectTerminalSurvives(
  userData: string,
  environmentId: string,
  handle: string,
  label: string
): Promise<void> {
  const listed = await orcaCliResult<RuntimeTerminalListResult>(userData, [
    'terminal',
    'list',
    '--environment',
    environmentId
  ])
  console.log(
    `[cli-matrix] terminals after ${label}: ${JSON.stringify(listed.terminals.map((terminal) => ({ handle: terminal.handle, connected: terminal.connected, exitCause: terminal.exitCause })))}`
  )
  expect(
    listed.terminals.map((terminal) => terminal.handle),
    label
  ).toContain(handle)
  const marker = `ORCA_CLI_SURVIVED_${Date.now()}`
  await sendLine(userData, environmentId, handle, `echo ${marker}`)
  await waitForEchoedLine(userData, environmentId, handle, marker)
}

/** The client's verdict on the managed server, after asking it once through the main process. */
async function hostVerdict(page: Page, environmentId: string): Promise<string> {
  const snapshot = await page.evaluate(async (id) => {
    await window.api.runtimeEnvironments
      .call({ selector: id, method: 'status.get', timeoutMs: 5_000 })
      .catch(() => null)
    const snapshots = await window.api.runtimeEnvironments.getStatusSnapshots()
    return snapshots.find((entry) => entry.environmentId === id) ?? null
  }, environmentId)
  if (!snapshot) {
    return 'no-snapshot'
  }
  const contact = runtimeHostContactFromSnapshot(snapshot)
  return contact.verdict === 'unverifiable' ? `unverifiable:${contact.reason}` : contact.verdict
}

test('@orcad-cli-managed an empty Windows host deploys, serves CLI terminals through reconnect, decommissions and redeploys, then survives an orcad restart', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its launch through a restart session.
{}, testInfo) => {
  skipUnlessWindowsHost()
  test.setTimeout(40 * 60_000)
  resetScratch()
  const host = startOrcadConvertHost(HOST!, testInfo)
  const descriptor = readWindowsHostCellDescriptor(HOST!)
  const session = createRestartSession(testInfo, launchEnv())
  let app: ElectronApplication | null = null
  try {
    const launched = await session.launch({ onStderr: sshStderr })
    app = launched.app
    const { page } = launched
    const userData = session.userDataDir
    await waitForSessionReady(page)

    // (a) Empty host: the first connect deploys managed orcad.
    const targetId = await page.evaluate(
      async (input) => (await window.api.ssh.addTarget({ target: input })).target.id,
      host.input
    )
    const connected = await reconnect(page, targetId)
    testInfo.annotations.push({
      type: 'first-connect',
      description: connected
    })
    const environmentId = await waitForManaged(page, targetId)
    expect(await listHostOrcadProcesses(descriptor.home)).not.toHaveLength(0)

    const sshRow = (await hostRows(userData)).find((row) => row.id === targetId)
    expect(sshRow, 'orca host list names the SSH target').toMatchObject({
      kind: 'ssh',
      connected: true
    })
    testInfo.annotations.push({
      type: 'host-list-platform',
      description: String(sshRow?.platform)
    })
    expect(await environmentIds(userData)).toContain(environmentId)
    const shown = await orcaCliResult<{ environment: EnvironmentRow }>(userData, [
      'environment',
      'show',
      '--environment',
      environmentId
    ])
    expect(shown.environment.id).toBe(environmentId)
    const status = await orcaCliResult(userData, [
      'environment',
      'status',
      '--environment',
      environmentId
    ])
    testInfo.annotations.push({ type: 'environment-status', description: JSON.stringify(status) })

    const added = await orcaCliResult<{ repo: { id: string } }>(userData, [
      'repo',
      'add',
      '--environment',
      environmentId,
      '--path',
      host.remoteRepoPath
    ])
    const worktrees = await orcaCliResult<{
      worktrees: { id: string; path: string }[]
    }>(userData, ['worktree', 'list', '--environment', environmentId])
    const worktree = worktrees.worktrees.find((entry) => samePath(entry.path, host.remoteRepoPath))
    expect(worktree, `a worktree at ${host.remoteRepoPath}`).toBeTruthy()
    const created = await orcaCliResult<{ terminal: { handle: string } }>(userData, [
      'terminal',
      'create',
      '--environment',
      environmentId,
      '--worktree',
      `id:${worktree!.id}`,
      '--title',
      'cli-matrix'
    ])
    const handle = created.terminal.handle
    const before = `ORCA_CLI_BEFORE_${Date.now()}`
    await sendLine(userData, environmentId, handle, `echo ${before}`)
    await waitForEchoedLine(userData, environmentId, handle, before)

    // Port detection: a listener started in a workspace terminal is reported as that workspace's port.
    await expectWorkspacePortDetected(page, userData, environmentId, added.repo.id, worktree!)

    // Disconnect and reconnect: the server, and the terminal it runs, outlive the SSH session.
    expect(await reconnect(page, targetId)).toContain('"managed"')
    expect(await waitForManaged(page, targetId)).toBe(environmentId)
    const relisted = await orcaCliResult<RuntimeTerminalListResult>(userData, [
      'terminal',
      'list',
      '--environment',
      environmentId
    ])
    expect(relisted.terminals.map((terminal) => terminal.handle)).toContain(handle)
    await waitForEchoedLine(userData, environmentId, handle, before)
    const after = `ORCA_CLI_AFTER_${Date.now()}`
    await sendLine(userData, environmentId, handle, `echo ${after}`)
    await waitForEchoedLine(userData, environmentId, handle, after)

    // (e) `environment rm` refuses a server Orca manages over SSH; the stop decommissions it.
    const refused = await runCompiledOrcaCli(userData, [
      'environment',
      'rm',
      '--environment',
      environmentId,
      '--json'
    ])
    expect(refused.code, refused.stdout).not.toBe(0)
    expect(`${refused.stdout}${refused.stderr}`).toContain('managed by Orca over SSH')
    expect(`${refused.stdout}${refused.stderr}`).toContain('orca environment stop')
    const unconfirmed = await runCompiledOrcaCli(userData, [
      'environment',
      'stop',
      '--environment',
      environmentId,
      '--json'
    ])
    expect(unconfirmed.json?.error?.code, unconfirmed.stdout).toBe('confirmation_required')
    await orcaCliResult(userData, [
      'terminal',
      'close',
      '--environment',
      environmentId,
      '--worktree',
      `id:${worktree!.id}`,
      '--all'
    ])
    const stopped = await orcaCliResult(userData, [
      'environment',
      'stop',
      '--environment',
      environmentId,
      '--yes'
    ])
    expect(stopped, JSON.stringify(stopped)).toMatchObject({
      outcome: 'unlinked',
      verdict: 'exited'
    })
    await expect
      .poll(async () => (await listHostOrcadProcesses(descriptor.home)).length, { timeout: 60_000 })
      .toBe(0)
    expect(await environmentIds(userData)).not.toContain(environmentId)

    // A reconnect after decommission redeploys onto the cleaned host.
    testInfo.annotations.push({
      type: 'redeploy-connect',
      description: await reconnect(page, targetId)
    })
    const redeployed = await waitForManaged(page, targetId)
    expect(await environmentIds(userData)).toContain(redeployed)
    expect(await listHostOrcadProcesses(descriptor.home)).not.toHaveLength(0)

    // A terminal on the redeployed server, so the restart below shows what happens to it.
    // Why unchecked: the decommissioned server's catalog may or may not have kept the repo.
    await runCompiledOrcaCli(userData, [
      'repo',
      'add',
      '--environment',
      redeployed,
      '--path',
      host.remoteRepoPath,
      '--json'
    ])
    const redeployedWorktree = (
      await orcaCliResult<{ worktrees: { id: string; path: string }[] }>(userData, [
        'worktree',
        'list',
        '--environment',
        redeployed
      ])
    ).worktrees.find((entry) => samePath(entry.path, host.remoteRepoPath))
    expect(redeployedWorktree, `a worktree at ${host.remoteRepoPath}`).toBeTruthy()
    const restartHandle = (
      await orcaCliResult<{ terminal: { handle: string } }>(userData, [
        'terminal',
        'create',
        '--environment',
        redeployed,
        '--worktree',
        `id:${redeployedWorktree!.id}`
      ])
    ).terminal.handle
    const beforeRestart = `ORCA_CLI_RESTART_${Date.now()}`
    await sendLine(userData, redeployed, restartHandle, `echo ${beforeRestart}`)
    await waitForEchoedLine(userData, redeployed, restartHandle, beforeRestart)

    // (d) Last, since a relaunch on connect is still landing: orcad restart: unreachable reads unverifiable, never retired or refused, then live again.
    expect(await hostVerdict(page, redeployed)).toBe('live')
    const killed = await killHostOrcad(descriptor.home)
    expect(killed, 'an orcad process to restart').not.toHaveLength(0)
    console.log(`[cli-matrix] killed orcad: ${JSON.stringify(killed)}`)
    const verdicts: string[] = []
    const sample = async (): Promise<string> => {
      const verdict = await hostVerdict(page, redeployed)
      if (verdicts.at(-1) !== verdict) {
        verdicts.push(verdict)
      }
      return verdict
    }
    await expect.poll(sample, { timeout: 90_000 }).toMatch(/^unverifiable:/u)
    let recoveredBy = 'automatic'
    try {
      await expect.poll(sample, { timeout: 120_000 }).toBe('live')
    } catch {
      recoveredBy = 'reconnect'
      testInfo.annotations.push({
        type: 'restart-reconnect',
        description: await reconnect(page, targetId)
      })
      await expect.poll(sample, { timeout: 4 * 60_000 }).toBe('live')
    }
    const relaunched = await listHostOrcadServerProcesses(descriptor.home)
    console.log(
      `[cli-matrix] orcad restart ${recoveredBy}: ${verdicts.join(' -> ')}; killed ${killed.map((entry) => entry.pid).join(',')}, now ${relaunched.map((entry) => entry.pid).join(',')}`
    )
    expect(verdicts.filter((verdict) => !/^(live|unverifiable:)/u.test(verdict))).toEqual([])
    expect(relaunched).not.toHaveLength(0)
    expect(relaunched.some((entry) => killed.some((victim) => victim.pid === entry.pid))).toBe(
      false
    )
    // The terminal daemon outlives orcad, so the relaunched server adopts its terminal.
    await expectTerminalSurvives(userData, redeployed, restartHandle, 'automatic restart')

    // Killed again, then disconnect/connect: the connect itself starts orcad and stays managed.
    const killedAgain = await killHostOrcad(descriptor.home)
    expect(killedAgain, 'an orcad process to restart').not.toHaveLength(0)
    const reconnected = await reconnect(page, targetId)
    console.log(`[cli-matrix] connect after second kill: ${reconnected}`)
    expect(reconnected).toContain('"managed"')
    expect(await waitForManaged(page, targetId)).toBe(redeployed)
    await expect.poll(() => hostVerdict(page, redeployed), { timeout: 4 * 60_000 }).toBe('live')
    const afterConnect = await listHostOrcadServerProcesses(descriptor.home)
    expect(
      afterConnect.some((entry) => killedAgain.some((victim) => victim.pid === entry.pid))
    ).toBe(false)
    await expectTerminalSurvives(userData, redeployed, restartHandle, 'reconnect restart')
  } finally {
    if (app) {
      await session.close(app)
    }
    await disposeQuietly(session)
    host.cleanup()
    rmSync(SCRATCH, { recursive: true, force: true })
  }
})

test('@orcad-cli-convert a seeded relay-era profile converts its Windows host, keeps then retires its source, and the CLI reaches its projects', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its launches through a restart session.
{}, testInfo) => {
  skipUnlessWindowsHost()
  test.setTimeout(20 * 60_000)
  resetScratch()
  const host = startOrcadConvertHost(HOST!, testInfo)
  const session = createRestartSession(testInfo, launchEnv())
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    const upgraded = await session.launch({ onStderr: sshStderr })
    app = upgraded.app
    await waitForSessionReady(upgraded.page)
    await convertThenRetire(upgraded.page, session.userDataDir, seeded, FLAGS_FILE)

    const environmentId = await waitForManaged(upgraded.page, seeded.targetId)
    expect(await environmentIds(session.userDataDir)).toContain(environmentId)
    expect(
      (await hostRows(session.userDataDir)).find((row) => row.id === seeded.targetId)
    ).toMatchObject({
      kind: 'ssh',
      connected: true
    })
    const repos = await orcaCliResult<{ repos: { path: string }[] }>(session.userDataDir, [
      'repo',
      'list',
      '--environment',
      environmentId
    ])
    expect(repos.repos.some((repo) => samePath(repo.path, seeded.repoPath))).toBe(true)
  } finally {
    if (app) {
      await session.close(app)
    }
    await disposeQuietly(session)
    host.cleanup()
    rmSync(SCRATCH, { recursive: true, force: true })
  }
})

test('@orcad-cli-relay-kept an open relay terminal keeps a Windows host on the relay until the CLI closes it', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its launches through a restart session.
{}, testInfo) => {
  skipUnlessWindowsHost()
  test.setTimeout(30 * 60_000)
  resetScratch()
  const host = startOrcadConvertHost(HOST!, testInfo)
  // Long enough that the relay, and its terminal, outlive the app between launches.
  // Pinned node: the lane hides host Node, so the default runtime can't start a relay here.
  const input = {
    ...host.input,
    relayGracePeriodSeconds: 900,
    remoteRuntime: 'pinned-node' as const
  }
  const session = createRestartSession(testInfo, launchEnv())
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    // Why retried: Playwright can drop the first main-process evaluate on a cold Windows launch.
    const readVersion = (): Promise<string> =>
      first.app.evaluate(({ app: electronApp }) => electronApp.getVersion())
    const appVersion = await readVersion().catch(readVersion)
    await session.close(app)
    app = null
    // Why a recorded "can't run": the Windows relay needs the template that would otherwise convert.
    const targetId = seedRelayEraTarget(session.userDataDir, input, {
      managedServerUnavailable: { reason: 'e2e_relay_era', appVersion }
    })

    // Relay era: one shell running on the relay.
    const relayEra = await session.launch({ onStderr: sshStderr })
    app = relayEra.app
    await waitForSessionReady(relayEra.page)
    const remote = await connectSshTestTarget(relayEra.page, input, {
      remotePath: host.remoteRepoPath,
      displayName: 'orcad cli relay-kept E2E',
      seedInitialTab: true,
      existingTargetId: targetId
    })
    expect(await managedServer(relayEra.page, targetId)).toMatchObject({
      kind: 'relay',
      reason: 'orcad_unavailable'
    })
    await ensureTerminalVisible(relayEra.page, 45_000)
    const ptyId = await waitForActivePanePtyId(relayEra.page, 60_000)
    const marker = `ORCA_RELAY_KEPT_${Date.now()}`
    await execInTerminal(relayEra.page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(relayEra.page, marker, 30_000)
    const localTerminals = await orcaCliResult<RuntimeTerminalListResult>(session.userDataDir, [
      'terminal',
      'list',
      '--worktree',
      `id:${remote.worktreeId}`
    ])
    expect(localTerminals.terminals.length, 'the CLI lists the relay terminal').toBeGreaterThan(0)
    await session.close(app)
    app = null
    await mutateStoppedProfileStateWhenReleased(session.userDataDir, (state) => {
      const targets = Array.isArray(state.sshTargets) ? state.sshTargets : []
      for (const target of targets) {
        if (target?.id === targetId) {
          delete target.managedServerUnavailable
        }
      }
    })

    // Converting build with the relay terminal still open: the host stays on the relay.
    const kept = await session.launch({ onStderr: sshStderr })
    app = kept.app
    const page = kept.page
    await waitForSessionReady(page)
    testInfo.annotations.push({
      type: 'kept-connect',
      description: await reconnect(page, targetId)
    })
    await expect
      .poll(async () => JSON.stringify(await managedServer(page, targetId)), {
        timeout: 120_000
      })
      .toContain('relay_terminals_live')
    const status = await managedServer(page, targetId)
    console.log(`[cli-matrix] relay-kept census: ${JSON.stringify(status)}`)
    expect(status).toMatchObject({ kind: 'relay', reason: 'relay_terminals_live' })
    const count =
      status &&
      typeof status === 'object' &&
      'terminals' in status &&
      typeof status.terminals === 'number'
        ? status.terminals
        : 0
    expect(count).toBeGreaterThan(0)
    await page.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'ssh', repoId: null })
      state.openSettingsPage()
    })
    const section = page.locator('[data-settings-section="ssh"]')
    await expect
      .poll(async () => ((await section.count()) ? await section.innerText() : ''), {
        timeout: 30_000
      })
      .toMatch(new RegExp(`Runs the relay until its ${count} open terminals? (is|are) closed`, 'u'))
    expect((await hostRows(session.userDataDir)).find((row) => row.id === targetId)).toMatchObject({
      kind: 'ssh',
      connected: true
    })

    // The CLI closes the relay terminals; with none left, the next connect converts.
    // The close must confirm the relay PTY's exit (#25304); its timing tells a lagging record apart.
    const closeStartedAt = Date.now()
    const closed = await runCompiledOrcaCli(session.userDataDir, [
      'terminal',
      'close',
      '--worktree',
      `id:${remote.worktreeId}`,
      '--all',
      '--json'
    ])
    console.log(`[cli-matrix] relay close took ${Date.now() - closeStartedAt}ms: ${closed.stdout}`)
    expect(closed.json?.ok, closed.stdout).toBe(true)
    await expect
      .poll(
        async () =>
          JSON.stringify({
            sessions: await page.evaluate(
              (connectionId) => window.api.pty.listSessions({ connectionId }),
              targetId
            ),
            leases: targetLeases(session.userDataDir, targetId).filter(
              (lease) => lease.state === 'attached' || lease.state === 'detached'
            )
          }),
        { timeout: 60_000 }
      )
      .toBe(JSON.stringify({ sessions: [], leases: [] }))
    testInfo.annotations.push({
      type: 'convert-connect',
      description: await reconnect(page, targetId)
    })
    const environmentId = await waitForManaged(page, targetId)
    expect(await environmentIds(session.userDataDir)).toContain(environmentId)
    const repos = await orcaCliResult<{ repos: { path: string }[] }>(session.userDataDir, [
      'repo',
      'list',
      '--environment',
      environmentId
    ])
    expect(repos.repos.some((repo) => samePath(repo.path, host.remoteRepoPath))).toBe(true)
  } finally {
    if (app) {
      await session.close(app)
    }
    await disposeQuietly(session)
    host.cleanup()
    rmSync(SCRATCH, { recursive: true, force: true })
  }
})
