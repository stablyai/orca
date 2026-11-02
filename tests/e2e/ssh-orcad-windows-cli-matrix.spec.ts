// Run bundled CLI against real Windows OpenSSH host cells; invoke-windows-host-cells.ps1 selects @orcad-cli-managed/@orcad-cli-convert.
// Managed covers deploy/list, terminal reconnect, decommission/redeploy and unverifiable→live restart; convert preserves relay-era source and reaches migrated projects.
// ORCA_E2E_ORCAD_CONVERT_HOST names the descriptor; ORCA_E2E_ORCAD_CONVERT_TEMPLATE must match its target.
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { convertAndRetain, managedServer, reconnect } from './helpers/orcad-convert-flow'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { ORCAD_CONVERT_HOST_ENV, startOrcadConvertHost } from './helpers/orcad-convert-host'
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
}

function launchEnv(): Record<string, string> {
  return {
    ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE!
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
// Avoid $ expansion by the outer PowerShell; append the worktree path for Windows scanners, which cannot read process cwd.
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

    await expectWorkspacePortDetected(page, userData, environmentId, added.repo.id, worktree!)

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

    const refused = await runCompiledOrcaCli(userData, [
      'environment',
      'rm',
      '--environment',
      environmentId,
      '--json'
    ])
    expect(refused.code, refused.stdout).not.toBe(0)
    expect(`${refused.stdout}${refused.stderr}`).toContain(
      'Orca runs this server on an SSH host for you'
    )
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

    // Create a terminal before restart; do not assume the decommissioned server retained its repo catalog.
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

test('@orcad-cli-convert a seeded relay-era profile converts its Windows host, keeps its source retained, and the CLI reaches its projects', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its launches through a restart session.
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
    await convertAndRetain(upgraded.page, session.userDataDir, seeded)

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
