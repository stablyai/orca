import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  switchToOtherWorktree,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult, RuntimeTerminalRead } from '../../src/shared/runtime-types'

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-orchestration-worker-'))
const fakeCodexSource = `
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
let acknowledged = false
process.stdin.on('data', (chunk) => {
  if (!acknowledged && chunk.toString().includes('\\r')) {
    acknowledged = true
    process.stdout.write('ACK\\n')
  }
})
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
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`
    },
    { option: true }
  ]
})

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

test('worker-start materializes one inactive terminal tab before workspace re-entry', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const coordinatorTabId = await getActiveTabId(orcaPage)
  expect(coordinatorTabId).toBeTruthy()
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
    (terminal) => terminal.title === 'Codex Ready'
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
})
