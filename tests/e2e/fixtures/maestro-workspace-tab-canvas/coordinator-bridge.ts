import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../../src/cli/runtime-client'
import { AgentGraphViewSchema } from '../../../../src/shared/maestro-contract'
import { nodeTerminalCommand } from '../../terminal-node-command'
import { buildBrowserSurfaceReceipt } from './browser-surface-receipt'
import { buildCodexCoordinatorSource } from './codex-coordinator-source'
import { buildHarnessGraphView } from './harness-graph-view'
import { activeWorkspaceTabContentType, openMaestro, type MaestroScope } from './evidence'

async function call<TResult>(dir: string, method: string, params: unknown): Promise<TResult> {
  const label = method.replaceAll('.', '-')
  const result = path.join(dir, `${label}-result.json`)
  writeFileSync(path.join(dir, `${label}-request.json`), JSON.stringify({ method, params }))
  await expect.poll(() => existsSync(result), { timeout: 60_000 }).toBe(true)
  const response = JSON.parse(readFileSync(result, 'utf8')) as {
    ok?: boolean
    result?: TResult
    error?: unknown
  }
  expect(response.ok, JSON.stringify(response.error ?? response)).toBe(true)
  return response.result as TResult
}

export async function publishAuthenticatedHarness(params: {
  page: Page
  userDataDir: string
  scope: MaestroScope
  browserPageId: string
  browserUrl: string
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-mwc-codex-bridge-'))
  const bridge = path.join(dir, 'codex-coordinator.cjs')
  writeFileSync(
    bridge,
    buildCodexCoordinatorSource(dir, path.resolve('out/cli'), params.userDataDir)
  )
  const worktreeId = await params.page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('The active workspace is unavailable for the coordinator launch')
    }
    return state.activeWorktreeId
  })
  const client = new RuntimeClient(params.userDataDir, 30_000, null, null)
  const command = nodeTerminalCommand([bridge])
  const launchToken = randomUUID()
  const created = await client.call<{ terminal: { handle: string } }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    command,
    launchConfig: { agentCommand: command, agentArgs: '', agentEnv: {} },
    launchToken,
    launchAgent: 'codex',
    presentation: 'background',
    title: 'Authenticated coordinator PTY resource'
  })
  const livePath = path.join(dir, 'coordinator-live.json')
  await expect
    .poll(
      () => {
        if (!existsSync(livePath)) {
          return false
        }
        const receipt = JSON.parse(readFileSync(livePath, 'utf8')) as Record<string, unknown>
        return (
          Object.keys(receipt).sort().join(',') ===
            'launchTokenPresent,paneKey,pid,terminalHandle' &&
          Number.isInteger(receipt.pid) &&
          Number(receipt.pid) > 0 &&
          typeof receipt.terminalHandle === 'string' &&
          receipt.terminalHandle.length > 0 &&
          typeof receipt.paneKey === 'string' &&
          receipt.paneKey.length > 0 &&
          receipt.launchTokenPresent === true
        )
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  const liveReceipt = JSON.parse(readFileSync(livePath, 'utf8')) as {
    pid: number
    terminalHandle: string
    paneKey: string
    launchTokenPresent: true
  }
  await client.call('terminal.focus', {
    terminal: created.result.terminal.handle,
    navigation: 'host'
  })
  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: liveReceipt.paneKey
  })
  const handle = coordinator.result.terminal.handle
  expect(handle).toBe(liveReceipt.terminalHandle)
  expect(handle).toBe(created.result.terminal.handle)
  const workerCommand = nodeTerminalCommand([
    path.resolve('tests/e2e/fixtures/maestro-workspace-tab-canvas/codex-worker.cjs')
  ])
  await params.page.evaluate(async (command) => {
    const state = window.__store?.getState()
    await state?.updateSettings({
      agentCmdOverrides: { ...state.settings.agentCmdOverrides, codex: command }
    })
  }, workerCommand)
  const run = await call<{ run: { id: string; consumer_generation: number } }>(
    dir,
    'orchestration.runCreate',
    { objective: 'MWC authenticated progress evidence', from: handle }
  )
  await call(dir, 'orchestration.runUse', { id: run.run.id, from: handle })
  const task = await call<{ task: { id: string } }>(dir, 'orchestration.taskCreate', {
    run: run.run.id,
    spec: 'Pending exact workspace evidence',
    callerTerminalHandle: handle
  })
  const attemptId = `attempt-mwc-e2e-${process.pid}`
  const worker = await call<{
    readiness: string
    terminalHandle: string
    attemptId: string
  }>(dir, 'orchestration.workerStart', {
    task: task.task.id,
    attemptId,
    from: handle,
    agent: 'codex',
    timeoutMs: 30_000
  })
  expect(worker.readiness).toBe('ready')
  expect(worker.attemptId).toBe(attemptId)
  await openMaestro(params.page, true)
  await expect.poll(() => activeWorkspaceTabContentType(params.page)).toBe('maestro')
  await expect(params.page.locator('[data-maestro-workspace-canvas]')).toBeVisible()
  const terminal = await client.call<{ terminal: { tabId: string; worktreeId: string } }>(
    'terminal.show',
    {
      terminal: handle
    }
  )
  const separator = terminal.result.terminal.worktreeId.indexOf('::')
  expect(separator).toBeGreaterThan(0)
  const repositoryId = terminal.result.terminal.worktreeId.slice(0, separator)
  const workspacePath = terminal.result.terminal.worktreeId.slice(separator + 2)
  const now = new Date().toISOString()
  const view = buildHarnessGraphView({
    ...params,
    repositoryId,
    workspacePath,
    runId: run.run.id,
    generation: run.run.consumer_generation,
    taskId: task.task.id,
    attemptId,
    terminalHandle: worker.terminalHandle,
    now
  })
  const parsedView = AgentGraphViewSchema.safeParse(view)
  expect(parsedView.error?.issues ?? []).toEqual([])
  expect(parsedView.success && parsedView.data.progress !== undefined).toBe(true)
  await call(dir, 'maestro.projection.apply', {
    workspace: {
      repository_id: repositoryId,
      execution_host_id: params.scope.host,
      workspace_key: params.scope.workspace,
      run_id: run.run.id
    },
    view
  })
  const projection = await client.call<{
    nodes: { id: string; browserSurface?: unknown }[]
  } | null>('maestro.projection.get', {
    scope: { execution_host_id: params.scope.host, workspace_key: params.scope.workspace }
  })
  expect(
    projection.result?.nodes.find((node) => node.id === 'mwc-browser-receipt')?.browserSurface
  ).toEqual(
    buildBrowserSurfaceReceipt({
      ...params,
      runId: run.run.id,
      taskId: task.task.id,
      attemptId,
      now
    })
  )
  return {
    runId: run.run.id,
    workerTabId: (
      await client.call<{ terminal: { tabId: string } }>('terminal.show', {
        terminal: worker.terminalHandle
      })
    ).result.terminal.tabId,
    complete: async () => {
      await call(dir, 'orchestration.runComplete', {
        id: run.run.id,
        from: handle,
        summary: 'Verified Maestro Canvas handoff is complete.',
        evidence: ['Focused orchestration and Canvas checks passed.'],
        waivers: [
          {
            task_id: task.task.id,
            reason: 'The live coordinator resource remains available for visual inspection.'
          }
        ]
      })
    },
    cleanup: async () => {
      await client
        .call('terminal.close', { terminal: worker.terminalHandle })
        .catch(() => undefined)
      await client.call('terminal.close', { terminal: handle }).catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
