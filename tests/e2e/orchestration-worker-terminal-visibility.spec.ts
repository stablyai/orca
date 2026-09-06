import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from './helpers/fake-agent-command-override'
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
import type { RuntimeTerminalListResult, RuntimeTerminalRead } from '../../src/shared/runtime-types'

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-orchestration-worker-'))
const spawnLedgerPath = path.join(fakeCliDir, 'spawn.jsonl')
const interruptionLedgerPath = path.join(fakeCliDir, 'interruption.jsonl')
const fakeCodexPath = path.join(fakeCliDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const fakeCodexCommand = buildFakeAgentCommandOverride(fakeCodexPath)
const fakeCodexSource = `
const { appendFileSync } = require('node:fs')
function appendLedger(envName, event) {
  const ledgerPath = process.env[envName]
  if (!ledgerPath) return
  try {
    appendFileSync(ledgerPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...event }) + '\\n')
  } catch {}
}
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
appendLedger('ORCA_E2E_SPAWN_LEDGER', { event: 'spawn', startedAt: Date.now() })
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

const test = base.extend({
  launchEnv: [
    {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_SPAWN_LEDGER: spawnLedgerPath,
      ORCA_E2E_INTERRUPTION_LEDGER: interruptionLedgerPath
    },
    { option: true }
  ]
})

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

type LedgerEvent = {
  pid: number
  event: string
  startedAt?: number
  signal?: string
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

test('worker-start preserves one live inactive worker across workspace re-entry', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(
    async ({ agentCommand, terminalWindowsShell }) => {
      await window.__store?.getState().updateSettings({
        agentCmdOverrides: { codex: agentCommand },
        terminalWindowsShell
      })
    },
    { agentCommand: fakeCodexCommand, terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL }
  )
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const coordinatorTabId = await getActiveTabId(orcaPage)
  expect(coordinatorTabId).toBeTruthy()
  await waitForActivePanePtyId(orcaPage)
  const coordinatorPane = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: coordinatorPane.paneKey
  })
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Verify worker terminal visibility',
    from: coordinator.result.terminal.handle
  })
  const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
    spec: 'Respond ACK and remain idle',
    run: run.result.run.id,
    callerTerminalHandle: coordinator.result.terminal.handle
  })
  const coordinatorTerminal = await client.call<{ terminal: { worktreeId: string } }>(
    'terminal.show',
    { terminal: coordinator.result.terminal.handle }
  )
  await expect
    .poll(async () => {
      const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
      return listed.result.worktrees.some(
        (worktree) => worktree.id === coordinatorTerminal.result.terminal.worktreeId
      )
    })
    .toBe(true)

  const started = await client.call<{
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
  const workerTabTitle = `worker-${task.result.task.id}`

  const terminals = await client.call<RuntimeTerminalListResult>('terminal.list')
  const workerTerminal = terminals.result.terminals.find(
    (terminal) => terminal.handle === workerHandle
  )
  expect(workerTerminal?.tabId).toBeTruthy()
  expect(workerTerminal?.leafId).toBeTruthy()
  await expect
    .poll(async () => {
      const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
        terminal: workerTerminal!.handle,
        limit: 200
      })
      return read.result.terminal.tail.join('\n')
    })
    .toContain('ACK')
  const initialWorkerIdentity = {
    ptyId: workerTerminal!.ptyId,
    incarnationId: workerTerminal!.incarnationId,
    worktreeId: workerTerminal!.worktreeId,
    tabId: workerTerminal!.tabId,
    leafId: workerTerminal!.leafId
  }
  const initialDispatch = await client.call<{
    dispatch: { id: string; task_id: string; assignee_handle: string } | null
  }>('orchestration.dispatchShow', { task: task.result.task.id })
  expect(initialDispatch.result.dispatch).toEqual(
    expect.objectContaining({
      task_id: task.result.task.id,
      assignee_handle: workerHandle
    })
  )
  await expect.poll(() => readLedger(spawnLedgerPath)).toHaveLength(1)
  const [spawn] = readLedger(spawnLedgerPath)
  expect(spawn).toEqual(
    expect.objectContaining({
      event: 'spawn',
      pid: expect.any(Number),
      startedAt: expect.any(Number)
    })
  )
  expect(isProcessAlive(spawn.pid)).toBe(true)
  expect(readLedger(interruptionLedgerPath)).toEqual([])
  const workerTab = orcaPage.locator(
    `[data-testid="sortable-tab"][data-tab-id="${workerTerminal!.tabId}"]`
  )
  await expect(workerTab).toBeVisible()
  await expect(workerTab).toHaveAttribute('data-active', 'false')
  await expect(
    orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${coordinatorTabId}"]`)
  ).toHaveAttribute('data-active', 'true')

  await client.call('orchestration.send', {
    from: workerHandle,
    to: `run:${run.result.run.id}`,
    subject: 'ACK'
  })
  const checked = await client.call<{ messages: { subject: string }[] }>('orchestration.check', {
    terminal: 'term_stale_coordinator',
    terminalPaneKey: coordinatorPane.paneKey
  })
  expect(checked.result.messages).toEqual([expect.objectContaining({ subject: 'ACK' })])

  const otherWorktreeId = await switchToOtherWorktree(orcaPage, worktreeId)
  expect(otherWorktreeId).toBeTruthy()
  await expect(workerTab).not.toBeVisible()
  await switchToWorktree(orcaPage, worktreeId)

  await expect(workerTab).toBeVisible()
  await expect(
    orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${workerTerminal!.tabId}"]`)
  ).toHaveCount(1)
  await expect(
    orcaPage.locator(`[data-testid="sortable-tab"][data-tab-title="${workerTabTitle}"]`)
  ).toHaveCount(1)
  const terminalsAfterReturn = await client.call<RuntimeTerminalListResult>('terminal.list')
  const workerAfterReturn = terminalsAfterReturn.result.terminals.find(
    (terminal) => terminal.ptyId === initialWorkerIdentity.ptyId
  )
  expect(workerAfterReturn).toEqual(expect.objectContaining(initialWorkerIdentity))
  const dispatchAfterReturn = await client.call<{
    dispatch: { id: string; task_id: string; assignee_handle: string } | null
  }>('orchestration.dispatchShow', { task: task.result.task.id })
  expect(dispatchAfterReturn.result.dispatch).toEqual(initialDispatch.result.dispatch)
  expect(readLedger(spawnLedgerPath)).toEqual([spawn])
  expect(readLedger(interruptionLedgerPath)).toEqual([])
  expect(isProcessAlive(spawn.pid)).toBe(true)
  const workerOutputAfterReturn = await client.call<{ terminal: RuntimeTerminalRead }>(
    'terminal.read',
    {
      terminal: workerAfterReturn!.handle,
      limit: 200
    }
  )
  expect(workerOutputAfterReturn.result.terminal.tail.join('\n')).not.toContain(
    'Conversation interrupted'
  )
  await expect(orcaPage.locator('body')).not.toContainText('Conversation interrupted')
})
