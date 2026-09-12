import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './helpers/fake-agent-paste-end-scanner'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from './helpers/fake-agent-command-override'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { ORCHESTRATION_ENABLED_STORAGE_KEY } from '../../src/renderer/src/lib/orchestration-setup-state'
import type { TuiAgent } from '../../src/shared/tui-agent'

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-worker-launch-defaults-'))
const argvLedgerPath = path.join(fakeCliDir, 'worker-launch.jsonl')
const cliEntry = path.join(process.cwd(), 'out', 'cli', 'index.js')
const fakeCodexCommand = buildFakeAgentCommandOverride(
  path.join(fakeCliDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
)
const fakeClaudeCommand = buildFakeAgentCommandOverride(
  path.join(fakeCliDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
)
const fakeAgentSource = `
const { appendFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
if (args[0] === 'debug' && args[1] === 'models') {
  process.stdout.write(JSON.stringify({
    models: [{
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      visibility: 'list',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }]
    }]
  }) + '\\n')
  process.exit(0)
}
if (args.includes('--input-format') && args.includes('stream-json')) {
  let input = ''
  process.stdin.on('data', (chunk) => {
    input += chunk.toString()
  })
  process.stdin.on('end', () => {
    if (input.includes('list_models')) {
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          response: {
            models: [
              { value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
              { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }
            ]
          }
        }
      }) + '\\n')
    }
    process.exit(0)
  })
  process.stdin.resume()
} else {
  let capability = null
  const completedDispatches = new Set()
  let acknowledged = false
  ${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
  appendFileSync(process.env.ORCA_E2E_ARGV_LEDGER, JSON.stringify({ event: 'spawn', argv: args, at: Date.now() }) + '\\n')
  process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
  process.stdin.on('data', (chunk) => {
    const input = chunk.toString()
    const pasteEndScan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, input)
    fakeAgentPasteEndTail = pasteEndScan.tail
    if (pasteEndScan.pasteEndOffset !== null) {
      process.stdout.write('\\x1b[?25h')
    }
    const nextCapability = input.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    if (nextCapability && nextCapability !== capability) {
      capability = nextCapability
      acknowledged = false
    }
    if (!acknowledged) {
      fakeAgentMaybeAck(pasteEndScan, input, (mode) => {
        acknowledged = true
        const message = mode === 'bracketed' ? 'ACK' : 'PASTE_PROTOCOL_ERROR'
        process.stdout.write('\\u001b]0;Codex Working\\u0007' + message + '\\n')
        setTimeout(() => process.stdout.write('\\u001b]0;Codex Ready\\u0007'), 10)
      })
    }
    const encoded = input.match(/ORCA_E2E_WORKER_DONE:([A-Za-z0-9+/=]+)/)?.[1]
    if (!encoded || !capability) return
    const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    if (completedDispatches.has(request.dispatchId)) return
    completedDispatches.add(request.dispatchId)
    const sendArgs = [
      'orchestration', 'send',
      '--from', process.env.ORCA_TERMINAL_HANDLE,
      '--dispatch-capability', capability,
      '--to', request.coordinator,
      '--type', 'worker_done',
      '--subject', 'completed',
      '--body', 'Compiled CLI worker launch-defaults E2E completion.',
      '--task-id', request.taskId,
      '--dispatch-id', request.dispatchId,
      '--outcome', 'succeeded',
      '--json'
    ]
    const result = spawnSync(process.execPath, [process.env.ORCA_E2E_CLI_ENTRY, ...sendArgs], {
      env: process.env,
      encoding: 'utf8'
    })
    appendFileSync(process.env.ORCA_E2E_ARGV_LEDGER, JSON.stringify({
      event: 'worker_done',
      dispatchId: request.dispatchId,
      args: sendArgs,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    }) + '\\n')
  })
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  setInterval(() => {}, 60_000)
}
`

if (process.platform === 'win32') {
  writeFileSync(path.join(fakeCliDir, 'fake-agent.js'), fakeAgentSource)
  for (const agent of ['codex', 'claude']) {
    writeFileSync(
      path.join(fakeCliDir, `${agent}.cmd`),
      `@echo off\r\nnode "%~dp0\\fake-agent.js" %*\r\n`
    )
  }
} else {
  for (const agent of ['codex', 'claude']) {
    const executable = path.join(fakeCliDir, agent)
    writeFileSync(executable, `#!/usr/bin/env node\n${fakeAgentSource}`)
    chmodSync(executable, 0o755)
  }
}

const test = base.extend({
  launchEnv: [
    {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_ARGV_LEDGER: argvLedgerPath,
      ORCA_E2E_CLI_ENTRY: cliEntry
    },
    { scope: 'test' }
  ]
})

type LaunchSelection = {
  agent: string | null
  model: string | null
  effort: string | null
}

type WorkerStartResult = {
  taskId: string
  dispatchId: string
  state: string
  launch: {
    requested: LaunchSelection
    effective: LaunchSelection | null
  }
  effects: { kind: string; role?: string; id?: string }[]
}

type WorkerContext = {
  client: RuntimeClient
  userDataDir: string
  coordinatorHandle: string
  runId: string
}

type LedgerEntry = {
  event: 'spawn' | 'worker_done'
  argv?: string[]
  dispatchId?: string
  status?: number | null
}

function readLedger(): LedgerEntry[] {
  if (!existsSync(argvLedgerPath)) {
    return []
  }
  return readFileSync(argvLedgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry)
}

function readSpawns(): LedgerEntry[] {
  return readLedger().filter((entry) => entry.event === 'spawn')
}

function readCompletions(): LedgerEntry[] {
  return readLedger().filter((entry) => entry.event === 'worker_done')
}

function invokeCompiledCli(userDataDir: string, args: string[]) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8'
  })
}

function startWorker(context: WorkerContext, args: string[]): WorkerStartResult {
  const result = invokeCompiledCli(context.userDataDir, [
    'orchestration',
    'worker-start',
    '--task',
    args[0]!,
    '--from',
    context.coordinatorHandle,
    '--timeout-ms',
    '30000',
    '--json',
    ...args.slice(1)
  ])
  if (result.status !== 0) {
    throw new Error(
      `worker-start exited ${result.status}: ${result.stderr.trim()} ${result.stdout.trim()}`
    )
  }
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean
    result?: WorkerStartResult
    error?: unknown
  }
  if (!parsed.ok || !parsed.result) {
    throw new Error(`worker-start returned an error: ${JSON.stringify(parsed.error)}`)
  }
  return parsed.result
}

function workerHandle(started: WorkerStartResult): string {
  const handle = started.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'agent'
  )?.id
  if (!handle) {
    throw new Error('worker-start did not return an agent terminal effect')
  }
  return handle
}

function encodeWorkerDone(input: {
  coordinator: string
  taskId: string
  dispatchId: string
}): string {
  return Buffer.from(JSON.stringify(input)).toString('base64')
}

async function waitForSpawn(index: number): Promise<LedgerEntry> {
  await expect.poll(() => readSpawns().length, { timeout: 30_000 }).toBeGreaterThan(index)
  return readSpawns()[index]!
}

async function settleWorker(
  context: WorkerContext,
  started: WorkerStartResult,
  handle: string
): Promise<void> {
  const before = readCompletions().length
  await context.client.call('terminal.send', {
    terminal: handle,
    text: `ORCA_E2E_WORKER_DONE:${encodeWorkerDone({
      coordinator: context.coordinatorHandle,
      taskId: started.taskId,
      dispatchId: started.dispatchId
    })}`,
    enter: true
  })
  await expect.poll(() => readCompletions().length, { timeout: 30_000 }).toBeGreaterThan(before)
  expect(readCompletions().at(-1)?.status).toBe(0)
  await expect
    .poll(async () => {
      const current = await context.client.call<{ dispatch: { status: string } | null }>(
        'orchestration.dispatchShow',
        { task: started.taskId }
      )
      return current.result.dispatch?.status
    })
    .toBe('completed')
}

async function closeWorker(context: WorkerContext, handle: string): Promise<void> {
  await context.client.call('terminal.close', { terminal: handle })
  await expect
    .poll(async () => {
      const listed = await context.client.call<{ terminals: { handle: string }[] }>('terminal.list')
      return listed.result.terminals.some((terminal) => terminal.handle === handle)
    })
    .toBe(false)
}

async function configureFakeAgents(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await page.evaluate(
    async ({ claudeCommand, codexCommand, terminalWindowsShell }) => {
      const updateSettings = window.__store?.getState().updateSettings
      if (!updateSettings) {
        throw new Error('Renderer store is unavailable')
      }
      await updateSettings({
        uiLanguage: 'en',
        disabledTuiAgents: [],
        agentCmdOverrides: { claude: claudeCommand, codex: codexCommand },
        terminalWindowsShell,
        terminalHiddenViewParking: false,
        orchestrationDefaultWorkerAgent: null,
        orchestrationWorkerModels: {},
        orchestrationWorkerEfforts: {}
      })
    },
    {
      claudeCommand: fakeClaudeCommand,
      codexCommand: fakeCodexCommand,
      terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL
    }
  )
}

async function setWorkerPreferences(
  page: Page,
  preferences: {
    agent: TuiAgent | null
    models: Record<string, string>
    efforts: Record<string, string>
  }
): Promise<void> {
  await page.evaluate(async (next) => {
    await window.__store?.getState().updateSettings({
      orchestrationDefaultWorkerAgent: next.agent,
      orchestrationWorkerModels: next.models,
      orchestrationWorkerEfforts: next.efforts
    })
  }, preferences)
  await expect
    .poll(async () => {
      const settings = await page.evaluate(() => window.api.settings.get())
      return {
        agent: settings.orchestrationDefaultWorkerAgent,
        models: settings.orchestrationWorkerModels,
        efforts: settings.orchestrationWorkerEfforts
      }
    })
    .toEqual(preferences)
}

async function prepareContext(
  page: Page,
  electronApp: ElectronApplication
): Promise<WorkerContext> {
  await configureFakeAgents(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActivePanePtyId(page)
  const coordinatorPane = await waitForActivePaneHookDescriptor(page)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: coordinatorPane.paneKey
  })
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Worker launch defaults end-to-end E2E',
    from: coordinator.result.terminal.handle
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
  return {
    client,
    userDataDir,
    coordinatorHandle: coordinator.result.terminal.handle,
    runId: run.result.run.id
  }
}

async function createTask(context: WorkerContext, spec: string): Promise<string> {
  const task = await context.client.call<{ task: { id: string } }>('orchestration.taskCreate', {
    spec,
    run: context.runId,
    callerTerminalHandle: context.coordinatorHandle
  })
  return task.result.task.id
}

async function openOrchestrationSettings(page: Page) {
  await page.evaluate(
    ({ enabledKey }) => {
      localStorage.removeItem(enabledKey)
      const state = window.__store!.getState()
      state.setSettingsSearchQuery('orchestration')
      state.openSettingsPage()
    },
    { enabledKey: ORCHESTRATION_ENABLED_STORAGE_KEY }
  )
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /^Orchestration\b/ }).click()
  const section = page.locator('[data-settings-section="orchestration"]')
  await expect(section).toBeVisible({ timeout: 10_000 })
  await expect(section.getByText('Worker defaults', { exact: true })).toBeVisible()
  return section
}

async function chooseSetting(
  page: Page,
  section: ReturnType<Page['locator']>,
  name: string,
  option: string
): Promise<void> {
  await section.getByRole('combobox', { name }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test.describe.configure({ mode: 'serial' })

test.afterEach(() => {
  rmSync(argvLedgerPath, { force: true })
})

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

test('headline defaults set in Orchestration settings reach the spawned agent', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const context = await prepareContext(orcaPage, electronApp)
  const section = await openOrchestrationSettings(orcaPage)
  await chooseSetting(orcaPage, section, 'Default worker provider', 'Codex')
  await chooseSetting(orcaPage, section, 'Codex model', 'GPT-5.5')
  await chooseSetting(orcaPage, section, 'Codex effort', 'High')
  await expect
    .poll(async () => {
      const settings = await orcaPage.evaluate(() => window.api.settings.get())
      return {
        agent: settings.orchestrationDefaultWorkerAgent,
        models: settings.orchestrationWorkerModels,
        efforts: settings.orchestrationWorkerEfforts
      }
    })
    .toEqual({ agent: 'codex', models: { codex: 'gpt-5.5' }, efforts: { codex: 'high' } })

  const taskId = await createTask(context, 'Capture the worker launch argv.')
  const started = startWorker(context, [taskId])
  const entry = await waitForSpawn(0)
  const handle = workerHandle(started)
  try {
    console.log(`[worker-launch-defaults] Case 1 argv=${JSON.stringify(entry.argv)}`)
    expect(entry.argv).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=high'
    ])
    expect(started.launch).toEqual({
      requested: { agent: 'codex', model: 'gpt-5.5', effort: 'high' },
      effective: { agent: 'codex', model: 'gpt-5.5', effort: 'high' }
    })
  } finally {
    await settleWorker(context, started, handle)
    await closeWorker(context, handle)
  }
})

test('named Claude agent still receives its stored model and effort', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const context = await prepareContext(orcaPage, electronApp)
  await setWorkerPreferences(orcaPage, {
    agent: 'codex',
    models: { claude: 'opus' },
    efforts: { claude: 'high' }
  })
  const taskId = await createTask(context, 'Use the stored Claude launch preferences.')
  const started = startWorker(context, [taskId, '--agent', 'claude'])
  const entry = await waitForSpawn(0)
  const handle = workerHandle(started)
  try {
    console.log(`[worker-launch-defaults] Case 2 argv=${JSON.stringify(entry.argv)}`)
    expect(entry.argv).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '--effort',
      'high'
    ])
    expect(started.launch).toEqual({
      requested: { agent: 'claude', model: 'opus', effort: 'high' },
      effective: { agent: 'claude', model: 'opus', effort: 'high' }
    })
  } finally {
    await settleWorker(context, started, handle)
    await closeWorker(context, handle)
  }
})

test('explicit model overrides the stored model for a named agent', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const context = await prepareContext(orcaPage, electronApp)
  await setWorkerPreferences(orcaPage, {
    agent: 'codex',
    models: { claude: 'opus' },
    efforts: { claude: 'high' }
  })
  const taskId = await createTask(context, 'Use the explicit Claude model.')
  const started = startWorker(context, [taskId, '--agent', 'claude', '--model', 'haiku'])
  const entry = await waitForSpawn(0)
  const handle = workerHandle(started)
  try {
    console.log(`[worker-launch-defaults] Case 3 argv=${JSON.stringify(entry.argv)}`)
    expect(entry.argv).toEqual(['--dangerously-skip-permissions', '--model', 'haiku'])
    expect(started.launch).toEqual({
      requested: { agent: 'claude', model: 'haiku', effort: null },
      effective: { agent: 'claude', model: 'haiku', effort: null }
    })
  } finally {
    await settleWorker(context, started, handle)
    await closeWorker(context, handle)
  }
})

test('terminal reuse does not inject stored worker defaults', async ({ orcaPage, electronApp }) => {
  test.setTimeout(180_000)
  const context = await prepareContext(orcaPage, electronApp)
  await setWorkerPreferences(orcaPage, {
    agent: 'codex',
    models: { codex: 'gpt-5.5' },
    efforts: { codex: 'high' }
  })
  const firstTaskId = await createTask(context, 'Create a reusable worker terminal.')
  const first = startWorker(context, [firstTaskId, '--agent', 'codex'])
  await waitForSpawn(0)
  const handle = workerHandle(first)
  await settleWorker(context, first, handle)

  const before = readSpawns().length
  const reusedTaskId = await createTask(context, 'Reuse the worker terminal without defaults.')
  const reused = startWorker(context, [reusedTaskId, '--terminal', handle])
  await expect.poll(() => readSpawns().length).toBe(before)
  console.log(`[worker-launch-defaults] Case 4 argv=[] (reused ${handle})`)
  try {
    expect(reused.launch).toEqual({
      requested: { agent: null, model: null, effort: null },
      effective: { agent: null, model: null, effort: null }
    })
  } finally {
    await settleWorker(context, reused, handle)
    await closeWorker(context, handle)
  }
})

test('stored effort without a stored model does not fail worker-start', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const context = await prepareContext(orcaPage, electronApp)
  await setWorkerPreferences(orcaPage, {
    agent: 'codex',
    models: {},
    efforts: { codex: 'high' }
  })
  const taskId = await createTask(context, 'Launch without a stored model.')
  const started = startWorker(context, [taskId, '--agent', 'codex'])
  const entry = await waitForSpawn(0)
  const handle = workerHandle(started)
  try {
    console.log(`[worker-launch-defaults] Case 5 argv=${JSON.stringify(entry.argv)}`)
    expect(entry.argv).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(started.launch).toEqual({
      requested: { agent: 'codex', model: null, effort: null },
      effective: { agent: 'codex', model: null, effort: null }
    })
  } finally {
    await settleWorker(context, started, handle)
    await closeWorker(context, handle)
  }
})

test('stored Claude preferences do not leak into a Codex launch', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const context = await prepareContext(orcaPage, electronApp)
  await setWorkerPreferences(orcaPage, {
    agent: 'codex',
    models: { claude: 'opus' },
    efforts: { claude: 'high' }
  })
  const taskId = await createTask(context, 'Keep per-agent launch preferences scoped.')
  const started = startWorker(context, [taskId, '--agent', 'codex'])
  const entry = await waitForSpawn(0)
  const handle = workerHandle(started)
  try {
    console.log(`[worker-launch-defaults] Case 6 argv=${JSON.stringify(entry.argv)}`)
    expect(entry.argv).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(started.launch).toEqual({
      requested: { agent: 'codex', model: null, effort: null },
      effective: { agent: 'codex', model: null, effort: null }
    })
  } finally {
    await settleWorker(context, started, handle)
    await closeWorker(context, handle)
  }
})
