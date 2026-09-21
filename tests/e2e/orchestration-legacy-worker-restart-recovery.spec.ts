import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  ensureTerminalVisible,
  getActiveTabId,
  switchToOtherWorktree,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import Database from '../../src/main/sqlite/sync-database'
import {
  CURRENT_CONTRACT_VERSION,
  LEGACY_CONTRACT_VERSION,
  LEGACY_RUN_ID
} from '../../src/main/runtime/orchestration/db'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import type { RuntimeTerminalListResult, RuntimeTerminalRead } from '../../src/shared/runtime-types'
import { listAllOrchestrationRuns } from './orchestration-run-pages'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from './helpers/fake-agent-command-override'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './helpers/fake-agent-paste-end-scanner'

const PROVIDER_SESSION_ID = 'e2e-legacy-orchestration-worker'
const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-legacy-worker-'))
const spawnLedgerPath = path.join(fakeCliDir, 'spawn.jsonl')
const interruptionLedgerPath = path.join(fakeCliDir, 'interruption.jsonl')
const authorityLedgerPath = path.join(fakeCliDir, 'authority.jsonl')
const lifecycleLedgerPath = path.join(fakeCliDir, 'lifecycle.jsonl')
const fakeCodexCommand = buildFakeAgentCommandOverride(
  path.join(fakeCliDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
)
const fakeCodexSource = `
const { appendFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
function appendLedger(envName, event) {
  const ledgerPath = process.env[envName]
  if (!ledgerPath) return
  try {
    appendFileSync(ledgerPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...event }) + '\\n')
  } catch {}
}
async function emitAuthorityHook(hookEventName) {
  const port = process.env.ORCA_AGENT_HOOK_PORT
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  const launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
  if (!port || !token || !launchToken || !process.env.ORCA_PANE_KEY) return
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/hook/codex', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': token
      },
      body: JSON.stringify({
        paneKey: process.env.ORCA_PANE_KEY,
        tabId: process.env.ORCA_TAB_ID,
        worktreeId: process.env.ORCA_WORKTREE_ID,
        env: process.env.ORCA_AGENT_HOOK_ENV,
        version: process.env.ORCA_AGENT_HOOK_VERSION,
        launchToken,
        payload: {
          hook_event_name: hookEventName,
          prompt: 'Respond ACK and remain idle'
        }
      })
    })
    appendLedger('ORCA_E2E_AUTHORITY_LEDGER', {
      event: 'authority-hook',
      hookEventName,
      status: response.status
    })
  } catch (error) {
    appendLedger('ORCA_E2E_AUTHORITY_LEDGER', {
      event: 'authority-hook-error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
appendLedger('ORCA_E2E_SPAWN_LEDGER', { event: 'spawn', argv: process.argv.slice(2) })
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
const sessionStartHook = emitAuthorityHook('SessionStart')
let acknowledged = false
let lifecycleSent = false
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  const pasteEndScan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, input)
  fakeAgentPasteEndTail = pasteEndScan.tail
  if (pasteEndScan.pasteEndOffset !== null) {
    process.stdout.write('\\x1b[?25h')
  }
  if (input.includes('\\x03')) {
    appendLedger('ORCA_E2E_INTERRUPTION_LEDGER', { event: 'stdin-ctrl-c' })
  }
  if (!acknowledged) {
    fakeAgentMaybeAck(pasteEndScan, input, (mode) => {
      acknowledged = true
      void sessionStartHook.then(() => emitAuthorityHook('UserPromptSubmit'))
      const message = mode === 'bracketed' ? 'ACK' : 'PASTE_PROTOCOL_ERROR'
      process.stdout.write('\\u001b]0;Codex Working\\u0007' + message + '\\n')
      setTimeout(() => process.stdout.write('\\u001b]0;Codex Ready\\u0007'), 10)
    })
  }
  const legacyCompletion = input.match(/ORCA_E2E_RUN_LEGACY_DONE:([A-Za-z0-9+/=]+)/)
  if (!lifecycleSent && legacyCompletion) {
    lifecycleSent = true
    const identity = JSON.parse(Buffer.from(legacyCompletion[1], 'base64').toString('utf8'))
    const cliEntry = process.env.ORCA_E2E_CLI_ENTRY
    const args = [
      'orchestration',
      'send',
      '--to',
      identity.coordinatorHandle,
      '--type',
      'worker_done',
      '--subject',
      'Completed',
      '--body',
      'E2E retained legacy completion',
      '--payload',
      JSON.stringify({
        taskId: identity.taskId,
        dispatchId: identity.dispatchId,
        filesModified: []
      }),
      '--json'
    ]
    const result = cliEntry
      ? spawnSync(process.execPath, [cliEntry, ...args], {
          env: process.env,
          encoding: 'utf8'
        })
      : { status: 127, stdout: '', stderr: 'ORCA_E2E_CLI_ENTRY missing' }
    appendLedger('ORCA_E2E_LIFECYCLE_LEDGER', {
      event: 'legacy-command',
      argv: args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    })
    process.stdout.write(String(result.stdout || '') + String(result.stderr || ''))
  }
})
process.stdin.setRawMode?.(true)
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

type LedgerEvent = {
  pid: number
  event: string
  argv?: string[]
  signal?: string
  status?: number
  stdout?: string
  stderr?: string
  error?: string
  hookEventName?: string
}

type PersistedWorkspaceSession = {
  activeTabId?: string | null
  activeTabIdByWorktree?: Record<string, string | null>
  tabsByWorktree?: Record<string, { id: string }[]>
  terminalLayoutsByTabId?: Record<string, unknown>
  unifiedTabs?: Record<string, { id: string; entityId: string }[]>
  tabGroups?: Record<
    string,
    { activeTabId: string | null; tabOrder: string[]; recentTabIds?: string[] }[]
  >
  sleepingAgentSessionsByPaneKey?: Record<
    string,
    { providerSession?: { id?: unknown }; automaticResumeBlockedBy?: string }
  >
  terminalPtyIncarnationsByPaneKey?: Record<string, string>
  terminalSurfaceTombstonesByPaneKey?: Record<string, unknown>
}

type PersistedData = {
  workspaceSession?: PersistedWorkspaceSession
}

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

function persistedDataPath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function readPersistedData(userDataDir: string): PersistedData {
  return JSON.parse(readFileSync(persistedDataPath(userDataDir), 'utf8')) as PersistedData
}

function hasPersistedResumeRecord(userDataDir: string, paneKey: string): boolean {
  return (
    readPersistedData(userDataDir).workspaceSession?.sleepingAgentSessionsByPaneKey?.[paneKey]
      ?.providerSession?.id === PROVIDER_SESSION_ID
  )
}

async function readRendererRecoveryState(
  page: Page,
  paneKey: string,
  tabId: string
): Promise<{ sleeping: boolean; resumeClaim: boolean; pendingStartup: boolean }> {
  return page.evaluate(
    ({ workerPaneKey, workerTabId }) => {
      const state = window.__store?.getState()
      return {
        sleeping: Boolean(state?.sleepingAgentSessionsByPaneKey[workerPaneKey]),
        resumeClaim: Boolean(state?.automaticAgentResumeClaimsByTabId[workerTabId]),
        pendingStartup: Boolean(state?.pendingStartupByTabId[workerTabId])
      }
    },
    { workerPaneKey: paneKey, workerTabId: tabId }
  )
}

function stripLegacyWorkerRendererBinding(
  userDataDir: string,
  input: {
    worktreeId: string
    coordinatorTabId: string
    workerTabId: string
    workerPaneKey: string
  }
): void {
  const data = readPersistedData(userDataDir)
  const session = data.workspaceSession
  if (!session) {
    throw new Error('Expected a persisted workspace session')
  }
  const sleeping = session.sleepingAgentSessionsByPaneKey?.[input.workerPaneKey]
  if (sleeping?.providerSession?.id !== PROVIDER_SESSION_ID) {
    throw new Error('Expected the legacy worker resume record before removing its tab binding')
  }
  session.tabsByWorktree = {
    ...session.tabsByWorktree,
    [input.worktreeId]: (session.tabsByWorktree?.[input.worktreeId] ?? []).filter(
      (tab) => tab.id !== input.workerTabId
    )
  }
  delete session.terminalLayoutsByTabId?.[input.workerTabId]
  if (session.unifiedTabs?.[input.worktreeId]) {
    session.unifiedTabs[input.worktreeId] = session.unifiedTabs[input.worktreeId].filter(
      (tab) => tab.id !== input.workerTabId && tab.entityId !== input.workerTabId
    )
  }
  for (const group of session.tabGroups?.[input.worktreeId] ?? []) {
    group.tabOrder = group.tabOrder.filter((tabId) => tabId !== input.workerTabId)
    group.recentTabIds = group.recentTabIds?.filter((tabId) => tabId !== input.workerTabId)
    if (group.activeTabId === input.workerTabId) {
      group.activeTabId = input.coordinatorTabId
    }
  }
  session.activeTabId = input.coordinatorTabId
  session.activeTabIdByWorktree = {
    ...session.activeTabIdByWorktree,
    [input.worktreeId]: input.coordinatorTabId
  }
  delete session.terminalPtyIncarnationsByPaneKey?.[input.workerPaneKey]
  delete session.terminalSurfaceTombstonesByPaneKey?.[input.workerPaneKey]
  writeFileSync(persistedDataPath(userDataDir), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function assertDispatchRemainsCurrent(
  userDataDir: string,
  input: {
    dispatchId: string
    terminalHandle: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
  }
): void {
  const db = new Database(path.join(userDataDir, 'orchestration.db'))
  try {
    const authority = db
      .prepare(
        `SELECT dc.status AS dispatch_status, dc.assignee_handle, dc.assignee_pane_key,
                dc.process_incarnation, dc.contract_version, dc.capability_hash,
                wd.state AS worker_state, wd.worktree_id, wd.agent_terminal_handle
         FROM dispatch_contexts dc
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
         WHERE dc.id = ?`
      )
      .get(input.dispatchId)
    expect(authority).toEqual({
      dispatch_status: 'dispatched',
      assignee_handle: input.terminalHandle,
      assignee_pane_key: input.paneKey,
      process_incarnation: input.processIncarnation,
      contract_version: CURRENT_CONTRACT_VERSION,
      capability_hash: expect.any(String),
      worker_state: 'ready',
      worktree_id: input.worktreeId,
      agent_terminal_handle: input.terminalHandle
    })
  } finally {
    db.close()
  }
}

function markAssignmentAsPreUpdateLegacy(
  userDataDir: string,
  input: {
    taskId: string
    dispatchId: string
    terminalHandle: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
  }
): void {
  const db = new Database(path.join(userDataDir, 'orchestration.db'))
  try {
    const authority = db
      .prepare(
        `SELECT dc.status AS dispatch_status, dc.assignee_handle, dc.assignee_pane_key,
                dc.process_incarnation, wd.state AS worker_state, wd.worktree_id,
                wd.agent_terminal_handle
         FROM dispatch_contexts dc
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
         WHERE dc.id = ?`
      )
      .get(input.dispatchId)
    expect(authority).toEqual({
      dispatch_status: 'dispatched',
      assignee_handle: input.terminalHandle,
      assignee_pane_key: input.paneKey,
      process_incarnation: input.processIncarnation,
      worker_state: 'ready',
      worktree_id: input.worktreeId,
      agent_terminal_handle: input.terminalHandle
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare('UPDATE tasks SET run_id = ? WHERE id = ?').run(LEGACY_RUN_ID, input.taskId)
    db.prepare(
      `UPDATE dispatch_contexts
       SET run_id = ?, contract_version = ?, capability_hash = NULL,
           capability_revoked_at = NULL, launch_token_hash = NULL
       WHERE id = ?`
    ).run(LEGACY_RUN_ID, LEGACY_CONTRACT_VERSION, input.dispatchId)
    db.exec(`
      DROP INDEX IF EXISTS idx_messages_delivery_contract;
      DROP TABLE legacy_mail_receipts;
      DROP TABLE legacy_operation_receipts;
      DROP TABLE legacy_compatibility_principals;
      DROP TABLE legacy_adoptions;
    `)
    db.pragma('user_version = 18')
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

test.describe.configure({ mode: 'serial' })

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

for (const contractVersion of [LEGACY_CONTRACT_VERSION, CURRENT_CONTRACT_VERSION]) {
  const contractLabel = contractVersion === LEGACY_CONTRACT_VERSION ? 'legacy' : 'current'
  test(`adopts one live ${contractLabel} worker after restart without replaying resume`, async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both Electron launches and intentionally opts out of the default app fixture.
  {}, testInfo) => {
    test.setTimeout(300_000)
    rmSync(spawnLedgerPath, { force: true })
    rmSync(interruptionLedgerPath, { force: true })
    rmSync(authorityLedgerPath, { force: true })
    rmSync(lifecycleLedgerPath, { force: true })
    const repoPath = existsSync(TEST_REPO_PATH_FILE)
      ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
      : ''
    test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

    const session = createRestartSession(testInfo, {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_SPAWN_LEDGER: spawnLedgerPath,
      ORCA_E2E_INTERRUPTION_LEDGER: interruptionLedgerPath,
      ORCA_E2E_AUTHORITY_LEDGER: authorityLedgerPath,
      ORCA_E2E_LIFECYCLE_LEDGER: lifecycleLedgerPath,
      ORCA_E2E_CLI_ENTRY: path.join(process.cwd(), 'out', 'cli', 'index.js')
    })
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const first = await session.launch()
      firstApp = first.app
      const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
      await waitForSessionReady(first.page)
      await first.page.evaluate(
        async ({ agentCommand, terminalWindowsShell }) => {
          await window.__store?.getState().updateSettings({
            agentCmdOverrides: { codex: agentCommand },
            terminalWindowsShell
          })
        },
        { agentCommand: fakeCodexCommand, terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL }
      )
      await ensureTerminalVisible(first.page)
      const coordinatorTabId = await getActiveTabId(first.page)
      expect(coordinatorTabId).toBeTruthy()
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
          const listed = await firstClient.call<{ worktrees: { id: string }[] }>(
            'worktree.list',
            {}
          )
          return listed.result.worktrees.some(
            (candidate) => candidate.id === coordinatorTerminal.result.terminal.worktreeId
          )
        })
        .toBe(true)
      const run = await firstClient.call<{ run: { id: string } }>('orchestration.runCreate', {
        objective: 'Legacy worker restart recovery',
        from: coordinator.result.terminal.handle
      })
      const task = await firstClient.call<{ task: { id: string } }>('orchestration.taskCreate', {
        spec: 'Respond ACK and remain idle',
        run: run.result.run.id,
        callerTerminalHandle: coordinator.result.terminal.handle
      })
      const started = await firstClient.call<{
        effects: { kind: string; role?: string; id?: string }[]
      }>('orchestration.workerStart', {
        task: task.result.task.id,
        from: coordinator.result.terminal.handle,
        agent: 'codex',
        timeoutMs: 15_000
      })
      const workerHandle = started.result.effects.find(
        (effect) => effect.kind === 'terminal' && effect.role === 'agent'
      )?.id
      expect(workerHandle).toBeTruthy()

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
      expect(worker?.incarnationId).toBeTruthy()
      const workerPaneKey = `${worker!.tabId}:${worker!.leafId}`
      await expect
        .poll(async () => {
          const read = await firstClient.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
            terminal: worker!.handle,
            limit: 200
          })
          return read.result.terminal.tail.join('\n')
        })
        .toContain('ACK')
      const initialWorker = {
        ptyId: worker!.ptyId,
        incarnationId: worker!.incarnationId,
        worktreeId: worker!.worktreeId,
        tabId: worker!.tabId,
        leafId: worker!.leafId
      }
      const initialDispatch = await firstClient.call<{
        dispatch: {
          id: string
          task_id: string
          assignee_handle: string
          assignee_pane_key: string
          process_incarnation: string
        } | null
      }>('orchestration.dispatchShow', { task: task.result.task.id })
      expect(initialDispatch.result.dispatch).toEqual(
        expect.objectContaining({
          task_id: task.result.task.id,
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${initialWorker.ptyId}:${initialWorker.incarnationId}`
        })
      )
      const dispatchHandle = initialDispatch.result.dispatch!.assignee_handle
      await expect.poll(() => readLedger(spawnLedgerPath)).toHaveLength(1)
      const [initialSpawn] = readLedger(spawnLedgerPath)
      expect(isProcessAlive(initialSpawn.pid)).toBe(true)
      expect(readLedger(interruptionLedgerPath)).toEqual([])
      await expect
        .poll(() => readLedger(authorityLedgerPath))
        .toEqual([
          expect.objectContaining({
            event: 'authority-hook',
            hookEventName: 'SessionStart',
            status: 204
          }),
          expect.objectContaining({
            event: 'authority-hook',
            hookEventName: 'UserPromptSubmit',
            status: 204
          })
        ])

      const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
      await first.page.evaluate(
        ({
          agentCommand,
          paneKey,
          tabId,
          worktreeId: workerWorktreeId,
          terminalHandle,
          transcript
        }) => {
          window.__store?.getState().setAgentStatus(
            paneKey,
            { state: 'working', prompt: 'Respond ACK and remain idle', agentType: 'codex' },
            'Codex Ready',
            undefined,
            { tabId, worktreeId: workerWorktreeId, terminalHandle },
            {
              providerSession: {
                key: 'session_id',
                id: 'e2e-legacy-orchestration-worker',
                transcriptPath: transcript
              },
              launchConfig: {
                // Why not bare 'codex': resume prefers the captured command over
                // agentCmdOverrides, so a bare name would resolve the machine's real
                // Codex off PATH and unpin the adoption leg this spec exercises.
                agentCommand,
                agentArgs: '--dangerously-bypass-approvals-and-sandbox',
                agentEnv: {}
              }
            }
          )
          window.__store?.getState().captureAllSleepingAgentSessions('quit')
        },
        {
          agentCommand: fakeCodexCommand,
          paneKey: workerPaneKey,
          tabId: worker!.tabId,
          worktreeId: worker!.worktreeId,
          terminalHandle: worker!.handle,
          transcript: transcriptPath
        }
      )
      await expect
        .poll(() => hasPersistedResumeRecord(session.userDataDir, workerPaneKey), {
          timeout: 30_000
        })
        .toBe(true)

      await session.close(firstApp)
      firstApp = null
      expect(readLedger(spawnLedgerPath)).toEqual([initialSpawn])
      expect(readLedger(interruptionLedgerPath)).toEqual([])
      expect(isProcessAlive(initialSpawn.pid)).toBe(true)

      stripLegacyWorkerRendererBinding(session.userDataDir, {
        worktreeId,
        coordinatorTabId: coordinatorTabId!,
        workerTabId: worker!.tabId,
        workerPaneKey
      })
      const dispatchIdentity = {
        taskId: task.result.task.id,
        dispatchId: initialDispatch.result.dispatch!.id,
        terminalHandle: dispatchHandle,
        paneKey: workerPaneKey,
        processIncarnation: `${initialWorker.ptyId}:${initialWorker.incarnationId}`,
        worktreeId: initialWorker.worktreeId
      }
      if (contractVersion === LEGACY_CONTRACT_VERSION) {
        markAssignmentAsPreUpdateLegacy(session.userDataDir, dispatchIdentity)
      } else {
        assertDispatchRemainsCurrent(session.userDataDir, dispatchIdentity)
      }

      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)
      expect(await waitForActiveWorktree(second.page)).toBe(worktreeId)
      const secondClient = new RuntimeClient(session.userDataDir, 30_000, null, null)
      let recovered = (
        await secondClient.call<RuntimeTerminalListResult>('terminal.list')
      ).result.terminals.find((terminal) => terminal.ptyId === initialWorker.ptyId)
      await expect
        .poll(async () => {
          const listed = await secondClient.call<RuntimeTerminalListResult>('terminal.list')
          const matches = listed.result.terminals.filter(
            (terminal) => terminal.ptyId === initialWorker.ptyId
          )
          recovered = matches[0]
          return matches
        })
        .toEqual([
          expect.objectContaining({
            ...initialWorker,
            connected: true,
            writable: true
          })
        ])

      const recoveredTab = second.page.locator(
        `[data-testid="sortable-tab"][data-tab-id="${initialWorker.tabId}"]`
      )
      await expect(recoveredTab).toBeVisible()
      await expect(recoveredTab).toHaveCount(1)
      await expect(recoveredTab).toHaveAttribute('data-active', 'false')
      await expect(
        second.page.locator(`[data-testid="sortable-tab"][data-tab-id="${coordinatorTabId!}"]`)
      ).toHaveAttribute('data-active', 'true')
      await expect
        .poll(async () => {
          const read = await secondClient.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
            terminal: recovered!.handle,
            limit: 200
          })
          return read.result.terminal.tail.join('\n')
        })
        .toContain('ACK')

      let assignmentRunId = run.result.run.id
      if (contractVersion === LEGACY_CONTRACT_VERSION) {
        const runs = await listAllOrchestrationRuns(secondClient)
        assignmentRunId = runs.find(
          (candidate) =>
            candidate.objective === 'Recovered orchestration work from a contract update'
        )!.id
      }
      const restoredRun = await secondClient.call<{ run: { id: string } }>(
        'orchestration.runShow',
        { id: assignmentRunId }
      )
      expect(restoredRun.result.run.id).toBe(assignmentRunId)
      const tasks = await secondClient.call<{ tasks: { id: string }[] }>('orchestration.taskList', {
        run: assignmentRunId
      })
      expect(tasks.result.tasks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: task.result.task.id })])
      )
      const recoveredDispatch = await secondClient.call<{
        dispatch: {
          id: string
          task_id: string
          assignee_handle: string
          assignee_pane_key: string
          process_incarnation: string
          contract_version: number
        } | null
      }>('orchestration.dispatchShow', { task: task.result.task.id })
      expect(recoveredDispatch.result.dispatch).toEqual(
        expect.objectContaining({
          id: initialDispatch.result.dispatch!.id,
          task_id: task.result.task.id,
          assignee_handle: dispatchHandle,
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${initialWorker.ptyId}:${initialWorker.incarnationId}`,
          contract_version: contractVersion
        })
      )
      await expect
        .poll(async () => ({
          renderer: await readRendererRecoveryState(
            second.page,
            workerPaneKey,
            initialWorker.tabId
          ),
          persisted: hasPersistedResumeRecord(session.userDataDir, workerPaneKey)
        }))
        .toEqual({
          renderer: { sleeping: false, resumeClaim: false, pendingStartup: false },
          persisted: false
        })
      expect(readLedger(spawnLedgerPath)).toEqual([initialSpawn])
      expect(readLedger(interruptionLedgerPath)).toEqual([])
      expect(isProcessAlive(initialSpawn.pid)).toBe(true)

      if (contractVersion === LEGACY_CONTRACT_VERSION) {
        const legacyCompletion = Buffer.from(
          JSON.stringify({
            coordinatorHandle: coordinator.result.terminal.handle,
            taskId: task.result.task.id,
            dispatchId: initialDispatch.result.dispatch!.id
          })
        ).toString('base64')
        await secondClient.call('terminal.send', {
          terminal: recovered!.handle,
          text: `ORCA_E2E_RUN_LEGACY_DONE:${legacyCompletion}`,
          enter: true
        })
        await expect
          .poll(() => readLedger(lifecycleLedgerPath), { timeout: 30_000 })
          .toEqual([
            expect.objectContaining({
              event: 'legacy-command',
              pid: initialSpawn.pid,
              argv: [
                'orchestration',
                'send',
                '--to',
                coordinator.result.terminal.handle,
                '--type',
                'worker_done',
                '--subject',
                'Completed',
                '--body',
                'E2E retained legacy completion',
                '--payload',
                JSON.stringify({
                  taskId: task.result.task.id,
                  dispatchId: initialDispatch.result.dispatch!.id,
                  filesModified: []
                }),
                '--json'
              ],
              status: 0,
              stderr: ''
            })
          ])
        await expect
          .poll(async () => {
            const dispatch = await secondClient.call<{
              dispatch: { id: string; status: string } | null
            }>('orchestration.dispatchShow', { task: task.result.task.id })
            const listedTasks = await secondClient.call<{
              tasks: { id: string; status: string }[]
            }>('orchestration.taskList', { run: assignmentRunId })
            return {
              dispatch: dispatch.result.dispatch?.status,
              task: listedTasks.result.tasks.find(
                (candidate) => candidate.id === task.result.task.id
              )?.status
            }
          })
          .toEqual({ dispatch: 'completed', task: 'completed' })
        expect(readLedger(spawnLedgerPath)).toEqual([initialSpawn])
        expect(isProcessAlive(initialSpawn.pid)).toBe(true)
      } else {
        expect(readLedger(lifecycleLedgerPath)).toEqual([])
      }

      const otherWorktreeId = await switchToOtherWorktree(second.page, worktreeId)
      expect(otherWorktreeId).toBeTruthy()
      await switchToWorktree(second.page, worktreeId)
      await expect(recoveredTab).toBeVisible()
      await expect(recoveredTab).toHaveCount(1)
      await expect(recoveredTab).toHaveAttribute('data-active', 'false')
      await expect
        .poll(async () =>
          readRendererRecoveryState(second.page, workerPaneKey, initialWorker.tabId)
        )
        .toEqual({ sleeping: false, resumeClaim: false, pendingStartup: false })
      expect(readLedger(spawnLedgerPath)).toEqual([initialSpawn])
      expect(readLedger(interruptionLedgerPath)).toEqual([])
      expect(isProcessAlive(initialSpawn.pid)).toBe(true)
      await expect(second.page.locator('body')).not.toContainText('Conversation interrupted')
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
}
