import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { DaemonClient } from '../../src/main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../src/main/daemon/daemon-spawner'
import Database from '../../src/main/sqlite/sync-database'
import { LEGACY_CONTRACT_VERSION } from '../../src/main/runtime/orchestration/db'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import type { RuntimeTerminalListResult, RuntimeTerminalRead } from '../../src/shared/runtime-types'

const PROVIDER_SESSION_ID = 'e2e-missing-legacy-worker'
const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-missing-legacy-worker-'))
const spawnLedgerPath = path.join(fakeCliDir, 'spawn.jsonl')
const interruptionLedgerPath = path.join(fakeCliDir, 'interruption.jsonl')
const fakeCodexSource = `
const { appendFileSync } = require('node:fs')
function appendLedger(envName, event) {
  const ledgerPath = process.env[envName]
  if (!ledgerPath) return
  try {
    appendFileSync(ledgerPath, JSON.stringify({ pid: process.pid, ...event }) + '\\n')
  } catch {}
}
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
appendLedger('ORCA_E2E_SPAWN_LEDGER', { event: 'spawn' })
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
let acknowledged = false
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  if (input.includes('\\x03')) {
    appendLedger('ORCA_E2E_INTERRUPTION_LEDGER', { event: 'stdin-ctrl-c' })
  }
  if (!acknowledged && input.includes('\\r')) {
    acknowledged = true
    process.stdout.write('ACK\\n')
  }
})
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
  process.on(signal, () => {
    appendLedger('ORCA_E2E_INTERRUPTION_LEDGER', { event: 'signal', signal })
    process.exit(0)
  })
}
process.stdin.resume()
setInterval(() => {}, 60_000)
`

if (process.platform === 'win32') {
  writeFileSync(path.join(fakeCliDir, 'fake-codex.js'), fakeCodexSource)
  writeFileSync(
    path.join(fakeCliDir, 'codex.cmd'),
    '@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n'
  )
} else {
  const executable = path.join(fakeCliDir, 'codex')
  writeFileSync(executable, `#!/usr/bin/env node\n${fakeCodexSource}`)
  chmodSync(executable, 0o755)
}

type LedgerEvent = { pid: number; event: string; signal?: string }

function readLedger(ledgerPath: string): LedgerEvent[] {
  if (!existsSync(ledgerPath)) {
    return []
  }
  return readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEvent)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function removeDetachedDaemonSession(userDataDir: string, ptyId: string): Promise<void> {
  const daemonDir = path.join(userDataDir, 'daemon')
  const client = new DaemonClient({
    socketPath: getDaemonSocketPath(daemonDir),
    tokenPath: getDaemonTokenPath(daemonDir)
  })
  try {
    await client.ensureConnected()
    await client.request('kill', { sessionId: ptyId, immediate: true })
  } finally {
    client.disconnect()
  }
}

async function detachedDaemonSessionExists(userDataDir: string, ptyId: string): Promise<boolean> {
  const daemonDir = path.join(userDataDir, 'daemon')
  const client = new DaemonClient({
    socketPath: getDaemonSocketPath(daemonDir),
    tokenPath: getDaemonTokenPath(daemonDir)
  })
  try {
    await client.ensureConnected()
    const result = await client.request<{ sessions: { sessionId: string }[] }>(
      'listSessions',
      undefined
    )
    return result.sessions.some((session) => session.sessionId === ptyId)
  } finally {
    client.disconnect()
  }
}

function persistedDataPath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function hasPersistedResumeRecord(userDataDir: string, paneKey: string): boolean {
  const data = JSON.parse(readFileSync(persistedDataPath(userDataDir), 'utf8')) as {
    workspaceSession?: {
      sleepingAgentSessionsByPaneKey?: Record<string, { providerSession?: { id?: unknown } }>
    }
  }
  return (
    data.workspaceSession?.sleepingAgentSessionsByPaneKey?.[paneKey]?.providerSession?.id ===
    PROVIDER_SESSION_ID
  )
}

function markDispatchLegacy(userDataDir: string, dispatchId: string): void {
  const db = new Database(path.join(userDataDir, 'orchestration.db'))
  try {
    db.prepare(
      `UPDATE dispatch_contexts
       SET contract_version = ?, capability_hash = NULL, capability_revoked_at = NULL,
           launch_token_hash = NULL
       WHERE id = ?`
    ).run(LEGACY_CONTRACT_VERSION, dispatchId)
  } finally {
    db.close()
  }
}

function readSettledDispatch(userDataDir: string, dispatchId: string): unknown {
  const db = new Database(path.join(userDataDir, 'orchestration.db'))
  try {
    return db
      .prepare(
        `SELECT dc.status AS dispatch_status, wd.state AS worker_state, wd.stage
         FROM dispatch_contexts dc
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
         WHERE dc.id = ?`
      )
      .get(dispatchId)
  } finally {
    db.close()
  }
}

test.describe.configure({ mode: 'serial' })

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

test('a missing legacy worker cannot spawn a replacement during restart recovery', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  rmSync(spawnLedgerPath, { force: true })
  rmSync(interruptionLedgerPath, { force: true })
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  const session = createRestartSession(testInfo, {
    PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_SPAWN_LEDGER: spawnLedgerPath,
    ORCA_E2E_INTERRUPTION_LEDGER: interruptionLedgerPath
  })
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await ensureTerminalVisible(first.page)
    await getActiveTabId(first.page)
    await waitForActivePanePtyId(first.page)
    const coordinatorPane = await waitForActivePaneHookDescriptor(first.page)
    const firstClient = new RuntimeClient(session.userDataDir, 30_000, null, null)
    const coordinator = await firstClient.call<{ terminal: { handle: string } }>(
      'terminal.resolvePane',
      { paneKey: coordinatorPane.paneKey }
    )
    const coordinatorTerminal = await firstClient.call<{
      terminal: { worktreeId: string }
    }>('terminal.show', { terminal: coordinator.result.terminal.handle })
    await expect
      .poll(async () => {
        const listed = await firstClient.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        return listed.result.worktrees.some(
          (candidate) => candidate.id === coordinatorTerminal.result.terminal.worktreeId
        )
      })
      .toBe(true)
    const run = await firstClient.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Missing legacy worker recovery',
      from: coordinator.result.terminal.handle
    })
    const task = await firstClient.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec: 'Respond ACK and remain idle',
      run: run.result.run.id,
      callerTerminalHandle: coordinator.result.terminal.handle
    })
    await firstClient.call('orchestration.workerStart', {
      task: task.result.task.id,
      from: coordinator.result.terminal.handle,
      agent: 'codex',
      timeoutMs: 15_000
    })

    let worker = (
      await firstClient.call<RuntimeTerminalListResult>('terminal.list')
    ).result.terminals.find((terminal) => terminal.title === 'Codex Ready')
    await expect
      .poll(async () => {
        const listed = await firstClient.call<RuntimeTerminalListResult>('terminal.list')
        worker = listed.result.terminals.find((terminal) => terminal.title === 'Codex Ready')
        return worker?.ptyId ?? null
      })
      .toBeTruthy()
    const workerPaneKey = `${worker!.tabId}:${worker!.leafId}`
    await expect
      .poll(async () => {
        const read = await firstClient.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
          terminal: worker!.handle,
          limit: 100
        })
        return read.result.terminal.tail.join('\n')
      })
      .toContain('ACK')
    const dispatch = await firstClient.call<{
      dispatch: { id: string } | null
    }>('orchestration.dispatchShow', { task: task.result.task.id })
    expect(dispatch.result.dispatch?.id).toBeTruthy()
    await expect.poll(() => readLedger(spawnLedgerPath)).toHaveLength(1)
    const [initialSpawn] = readLedger(spawnLedgerPath)

    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    await first.page.evaluate(
      ({ paneKey, tabId, workerWorktreeId, terminalHandle, transcript }) => {
        window.__store?.getState().setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'Respond ACK and remain idle', agentType: 'codex' },
          'Codex Ready',
          undefined,
          { tabId, worktreeId: workerWorktreeId, terminalHandle },
          {
            providerSession: {
              key: 'session_id',
              id: 'e2e-missing-legacy-worker',
              transcriptPath: transcript
            },
            launchConfig: {
              agentCommand: 'codex',
              agentArgs: '--dangerously-bypass-approvals-and-sandbox',
              agentEnv: {}
            }
          }
        )
        window.__store?.getState().captureAllSleepingAgentSessions('quit')
      },
      {
        paneKey: workerPaneKey,
        tabId: worker!.tabId,
        workerWorktreeId: worker!.worktreeId,
        terminalHandle: worker!.handle,
        transcript: transcriptPath
      }
    )
    await expect.poll(() => hasPersistedResumeRecord(session.userDataDir, workerPaneKey)).toBe(true)
    markDispatchLegacy(session.userDataDir, dispatch.result.dispatch!.id)

    await session.close(firstApp)
    firstApp = null
    await removeDetachedDaemonSession(session.userDataDir, worker!.ptyId)
    await expect
      .poll(() => detachedDaemonSessionExists(session.userDataDir, worker!.ptyId))
      .toBe(false)
    await expect.poll(() => isProcessAlive(initialSpawn.pid)).toBe(false)
    rmSync(interruptionLedgerPath, { force: true })

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    expect(await waitForActiveWorktree(second.page)).toBe(worktreeId)
    const secondClient = new RuntimeClient(session.userDataDir, 30_000, null, null)
    await expect
      .poll(async () => {
        const listed = await secondClient.call<RuntimeTerminalListResult>('terminal.list')
        return listed.result.terminals.filter(
          (terminal) => terminal.ptyId === worker!.ptyId || terminal.title === 'Codex Ready'
        )
      })
      .toEqual([])
    await expect(
      second.page.locator(`[data-testid="sortable-tab"][data-tab-id="${worker!.tabId}"]`)
    ).toHaveCount(0)
    await expect
      .poll(() => readSettledDispatch(session.userDataDir, dispatch.result.dispatch!.id))
      .toEqual({
        dispatch_status: 'failed',
        worker_state: 'abandoned',
        stage: 'terminal_missing'
      })
    await expect
      .poll(() => hasPersistedResumeRecord(session.userDataDir, workerPaneKey))
      .toBe(false)
    expect(readLedger(spawnLedgerPath)).toEqual([initialSpawn])
    expect(readLedger(interruptionLedgerPath)).toEqual([])
  } finally {
    if (secondApp) {
      await session.close(secondApp).catch(() => undefined)
    }
    if (firstApp) {
      await session.close(firstApp).catch(() => undefined)
    }
    await session.dispose()
  }
})
