import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../../../src/cli/runtime-client'
import { buildFakeAgentCommandOverride } from '../../helpers/fake-agent-command-override'
import type { CompiledCliResult } from './compiled-cli-bridge'

export type RunFixture = {
  id: string
  consumerGeneration: number
}

export type TaskFixture = {
  id: string
  title: string
  displayName: string
}

export type WorkerFixture = {
  attemptId: string
  dispatchId: string
  handle: string
  tabId: string
  task: TaskFixture
}

export type WorkerLedgerEntry = {
  event: string
  terminalHandle: string
  taskId: string | null
  dispatchId: string | null
  result?: {
    status: number | null
    stdout: string
    stderr: string
  }
}

export type CliInvoker = {
  terminalHandle: string
  invoke<Result>(
    args: readonly string[],
    options?: { cwd?: string; input?: string }
  ): Promise<CompiledCliResult<Result>>
}

function requireSuccess<Result>(result: CompiledCliResult<Result>): Result {
  expect(result.status, `${result.stderr}\n${JSON.stringify(result.response, null, 2)}`).toBe(0)
  expect(result.response.ok, JSON.stringify(result.response)).toBe(true)
  if (!result.response.ok) {
    throw new Error(`${result.response.error.code}: ${result.response.error.message}`)
  }
  return result.response.result
}

function writeWorkerExecutable(root: string): string {
  const source = readFileSync(
    path.resolve('tests/e2e/fixtures/orchestration-maestro-contract-hardening/fake-codex.cjs'),
    'utf8'
  )
  mkdirSync(root, { recursive: true })
  const sourcePath = path.join(root, 'fake-codex.cjs')
  writeFileSync(sourcePath, source)
  if (process.platform === 'win32') {
    const executablePath = path.join(root, 'codex.cmd')
    writeFileSync(executablePath, '@echo off\r\nnode "%~dp0\\fake-codex.cjs" %*\r\n')
    return executablePath
  }
  chmodSync(sourcePath, 0o755)
  return sourcePath
}

export async function configureContractWorker(page: Page, root: string): Promise<void> {
  const executablePath = writeWorkerExecutable(path.join(root, 'worker-executable'))
  const command = buildFakeAgentCommandOverride(executablePath)
  const startupReplacement =
    process.platform === 'win32' ? `${command}; exit $LASTEXITCODE` : `exec ${command}`
  await page.evaluate(async (agentCommand) => {
    await window.__store?.getState().updateSettings({
      defaultTuiAgent: 'codex',
      agentCmdOverrides: { codex: agentCommand },
      agentDefaultArgs: { codex: '' },
      disabledTuiAgents: []
    })
  }, startupReplacement)
}

export async function discoverPublicWorkspaceKey(
  bridge: CliInvoker,
  workspacePath: string
): Promise<string> {
  const result = requireSuccess(
    await bridge.invoke<{ worktree: { workspaceKey: string } }>(['worktree', 'current', '--json'], {
      cwd: workspacePath
    })
  )
  expect(result.worktree.workspaceKey).toMatch(/^worktree:/)
  return result.worktree.workspaceKey
}

export async function createRun(
  bridge: CliInvoker,
  objective: string,
  cwd: string
): Promise<RunFixture> {
  const result = requireSuccess(
    await bridge.invoke<{ run: { id: string; consumer_generation: number } }>(
      [
        'orchestration',
        'run-create',
        '--objective',
        objective,
        '--from',
        bridge.terminalHandle,
        '--json'
      ],
      { cwd }
    )
  )
  return { id: result.run.id, consumerGeneration: result.run.consumer_generation }
}

export async function createTaskFromStdin(args: {
  bridge: CliInvoker
  run: RunFixture
  title: string
  displayName: string
  spec: string
  cwd: string
}): Promise<TaskFixture> {
  const result = requireSuccess(
    await args.bridge.invoke<{ task: { id: string } }>(
      [
        'orchestration',
        'task-create',
        '--spec-file',
        '-',
        '--task-title',
        args.title,
        '--display-name',
        args.displayName,
        '--run',
        args.run.id,
        '--from',
        args.bridge.terminalHandle,
        '--json'
      ],
      { cwd: args.cwd, input: args.spec }
    )
  )
  return { id: result.task.id, title: args.title, displayName: args.displayName }
}

export async function startAttemptBoundWorker(args: {
  bridge: CliInvoker
  client: RuntimeClient
  task: TaskFixture
  cwd: string
  attemptId: string
  workspaceKey: string
}): Promise<WorkerFixture> {
  const result = requireSuccess(
    await args.bridge.invoke<{
      dispatchId: string
      state: string
      effects: { kind: string; role?: string; id?: string }[]
    }>(
      [
        'orchestration',
        'worker-start',
        '--task',
        args.task.id,
        '--attempt-id',
        args.attemptId,
        '--agent',
        'codex',
        '--worktree',
        args.workspaceKey,
        '--from',
        args.bridge.terminalHandle,
        '--json'
      ],
      { cwd: args.cwd }
    )
  )
  expect(result.state).toBe('ready')
  const handle = result.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'agent'
  )?.id
  if (!handle) {
    throw new Error(`Attempt ${args.attemptId} did not return its agent terminal`)
  }
  const terminal = await args.client.call<{ terminal: { tabId: string } }>('terminal.show', {
    terminal: handle
  })
  return {
    attemptId: args.attemptId,
    dispatchId: result.dispatchId,
    handle,
    tabId: terminal.result.terminal.tabId,
    task: args.task
  }
}

export async function bootstrapProjection(args: {
  bridge: CliInvoker
  run: RunFixture
  workspaceKey: string
  cwd: string
  mutationId: string
}): Promise<Record<string, unknown>> {
  const payload = {
    schema_version: 1,
    protocol: 'maestro-bootstrap/v1',
    mutation: {
      mutation_id: args.mutationId,
      execution_host_id: 'local',
      workspace_key: args.workspaceKey,
      run_id: args.run.id
    },
    coordinator_generation: args.run.consumerGeneration
  }
  return requireSuccess(
    await args.bridge.invoke<Record<string, unknown>>(
      ['maestro', 'bootstrap', '--payload-file', '-', '--json'],
      { cwd: args.cwd, input: JSON.stringify(payload) }
    )
  )
}

export async function updateTaskStatus(args: {
  bridge: CliInvoker
  run: RunFixture
  task: TaskFixture
  status: 'blocked' | 'dispatched' | 'completed'
  cwd: string
  result?: string
}): Promise<void> {
  requireSuccess(
    await args.bridge.invoke(
      [
        'orchestration',
        'task-update',
        '--id',
        args.task.id,
        '--status',
        args.status,
        ...(args.result ? ['--result', args.result] : []),
        '--run',
        args.run.id,
        '--from',
        args.bridge.terminalHandle,
        '--json'
      ],
      { cwd: args.cwd }
    )
  )
}

export function readWorkerLedger(root: string): WorkerLedgerEntry[] {
  const ledgerPath = path.join(root, 'worker-ledger.jsonl')
  if (!existsSync(ledgerPath)) {
    return []
  }
  return readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkerLedgerEntry)
}

export async function sendWorkerMarker(
  root: string,
  worker: WorkerFixture,
  marker: string
): Promise<void> {
  const safeHandle = worker.handle.replaceAll(/[^A-Za-z0-9_-]/g, '_')
  appendFileSync(path.join(root, `worker-control-${safeHandle}.txt`), `${marker}\n`)
}

export async function closeFixtureTerminals(
  client: RuntimeClient,
  handles: readonly string[]
): Promise<void> {
  for (const handle of handles) {
    await client.call('terminal.close', { terminal: handle }).catch(() => undefined)
  }
}

export function cleanupContractFixture(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
