import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type {
  RuntimeStatus,
  RuntimeTerminalListResult,
  RuntimeTerminalWait
} from '../../src/shared/runtime-types'
import type { OrchestrationWorkerReadResult } from '../../src/shared/orchestration-worker-output'
import {
  ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY
} from '../../src/shared/protocol-version'

const pairingCodePath =
  process.env.STA4593_PAIRING_CODE_PATH ?? path.join(os.tmpdir(), 'sta4593-pairing-code.txt')
const remoteClientProfile = mkdtempSync(path.join(os.tmpdir(), 'sta4593-remote-client-'))
const remoteLedgerPath =
  process.env.STA4593_LEDGER_PATH ?? path.join(os.tmpdir(), 'sta4593-codex.jsonl')
const remoteWorktreePath =
  process.env.STA4593_REMOTE_WORKTREE_PATH ?? '/home/orca/sta4593-workspace'
const coordinatorMode = process.env.STA4593_COORDINATOR_MODE === 'headless' ? 'headless' : 'headful'
const expectFederatedRelease = process.env.STA4593_EXPECT_FEDERATED_RELEASE === '1'

type StartedWorker = {
  dispatchId: string
  handle: string
  runId: string
  taskId: string
}

type WorkerShow = {
  dispatch: { status: string; task_id: string }
  worker: {
    agent_terminal_handle: string | null
    worktree_id: string | null
    state: string
  }
  remoteRuntimeEpoch: string
  terminal: {
    handle: string
    connected: boolean
    command?: string | null
    exitCode?: number | null
  } | null
  observation: { status: string; exactWorker: boolean }
}

type RemoteAttachmentShow = {
  attachment: {
    terminal_handle: string | null
    worktree_id: string | null
    pane_key: string | null
    process_incarnation: string | null
    capability_hash: string | null
  }
  terminal: { handle: string } | null
  observation: { status: string; exactWorker: boolean }
}

type LedgerEntry = {
  event: string
  mismatch?: boolean
  status?: number
  stdout?: string
  terminal?: string
}

let ledgerBaselineLength = 0

function pairingCode(): string {
  if (!existsSync(pairingCodePath)) {
    throw new Error(`Missing STA-4593 pairing code at ${pairingCodePath}`)
  }
  return readFileSync(pairingCodePath, 'utf8').trim()
}

function readLedgerFile(): LedgerEntry[] {
  if (!existsSync(remoteLedgerPath)) {
    return []
  }
  return readFileSync(remoteLedgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry)
}

function readLedger(): LedgerEntry[] {
  return readLedgerFile().slice(ledgerBaselineLength)
}

function encodeMarker(input: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(input), 'ascii').toString('base64')
}

async function pairWsl(page: Page): Promise<string> {
  return page.evaluate(
    async ({ code, name }) => {
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode: code
      })
      const environments = await window.api.runtimeEnvironments.list()
      window.__store?.getState().setRuntimeEnvironments(environments)
      if (
        !(await window.__store?.getState().refreshRuntimeEnvironmentStatus(result.environment.id))
      ) {
        throw new Error('Windows coordinator could not reach the isolated WSL authority')
      }
      return result.environment.id
    },
    { code: pairingCode(), name: `STA-4593 WSL ${randomUUID()}` }
  )
}

async function waitForWorkerText(
  client: RuntimeClient,
  dispatchId: string,
  marker: string
): Promise<OrchestrationWorkerReadResult> {
  let latest: OrchestrationWorkerReadResult | null = null
  await expect
    .poll(async () => {
      latest = (
        await client.call<OrchestrationWorkerReadResult>('orchestration.workerRead', {
          dispatch: dispatchId,
          source: 'terminal',
          limit: 500
        })
      ).result
      return latest.source === 'terminal' ? latest.terminal.tail.join('\n') : ''
    })
    .toContain(marker)
  if (!latest) {
    throw new Error(`Worker ${dispatchId} never produced ${marker}`)
  }
  return latest
}

async function closeCreatedTerminals(
  remote: RuntimeClient,
  createdHandles: string[]
): Promise<void> {
  const listed = await remote.call<RuntimeTerminalListResult>('terminal.list', {})
  for (const handle of createdHandles) {
    if (!listed.result.terminals.some((terminal) => terminal.handle === handle)) {
      continue
    }
    try {
      await remote.call('terminal.close', { terminal: handle })
    } catch (error) {
      if (!hasRuntimeErrorCode(error, 'tab_not_found')) {
        throw error
      }
    }
  }
  await expect
    .poll(async () => {
      const remaining = await remote.call<RuntimeTerminalListResult>('terminal.list', {})
      return createdHandles.filter((handle) =>
        remaining.result.terminals.some((terminal) => terminal.handle === handle)
      )
    })
    .toEqual([])
}

function hasRuntimeErrorCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  // Older paired runtimes can preserve the exact message while dropping the string code.
  return ('code' in error && error.code === code) || ('message' in error && error.message === code)
}

test.afterAll(() => {
  rmSync(remoteClientProfile, { recursive: true, force: true })
})

test.skip(!process.env.STA4593_PAIRING_CODE_PATH, 'requires an explicit isolated WSL pairing')

test(`proves STA-4593 A/B/C across ${coordinatorMode} Windows and isolated WSL ${coordinatorMode === 'headful' ? '@headful' : '@headless'}`, async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(300_000)
  ledgerBaselineLength = readLedgerFile().length
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const coordinatorPane = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const local = new RuntimeClient(userDataDir, 30_000, null, null)
  const { RuntimeClient: CompiledRuntimeClient } =
    (await import('../../out/cli/runtime-client.js')) as { RuntimeClient: typeof RuntimeClient }
  const remote = new CompiledRuntimeClient(remoteClientProfile, 30_000, pairingCode(), null)
  const remoteStatus = (await remote.call<RuntimeStatus>('status.get', {})).result
  const supportsFederatedRelease = remoteStatus.capabilities?.includes(
    ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY
  )
  const supportsStopVerdict = remoteStatus.capabilities?.includes(
    ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY
  )
  const coordinator = await local.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: coordinatorPane.paneKey
  })
  const environmentId = await pairWsl(orcaPage)
  const remoteWorktrees = await remote.call<{
    worktrees: { id: string; path: string }[]
  }>('worktree.list', {})
  const remoteWorktree = remoteWorktrees.result.worktrees.find(
    (worktree) => worktree.path === remoteWorktreePath
  )
  if (!remoteWorktree) {
    throw new Error('Isolated WSL worktree was not loaded')
  }

  const createdHandles: string[] = []
  let cleanupAttempted = false
  const startWorker = async (label: string): Promise<StartedWorker> => {
    const run = await local.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: `STA-4593 invariant ${label}`,
      from: coordinator.result.terminal.handle
    })
    const task = await local.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec: `Execute deterministic invariant ${label}.`,
      run: run.result.run.id,
      callerTerminalHandle: coordinator.result.terminal.handle
    })
    const started = await local.call<{
      dispatchId: string
      state: string
      failedStage?: string
      lastError?: string
      effects: { kind: string; role?: string; id?: string }[]
      residualResources?: unknown[]
    }>('orchestration.workerStart', {
      task: task.result.task.id,
      from: coordinator.result.terminal.handle,
      on: environmentId,
      worktree: `id:${remoteWorktree.id}`,
      agent: 'codex',
      timeoutMs: 30_000
    })
    const handle = started.result.effects.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'agent'
    )?.id
    if (handle) {
      createdHandles.push(handle)
    }
    expect(started.result, JSON.stringify(started.result)).toMatchObject({ state: 'ready' })
    if (!handle) {
      throw new Error(`Worker ${label} returned no remote terminal`)
    }
    await waitForWorkerText(local, started.result.dispatchId, 'STA4593_INJECTION_ACK')
    return {
      dispatchId: started.result.dispatchId,
      handle,
      runId: run.result.run.id,
      taskId: task.result.task.id
    }
  }

  try {
    const workerA = await startWorker('A')
    const shownA = (
      await local.call<WorkerShow>('orchestration.workerShow', {
        dispatch: workerA.dispatchId
      })
    ).result
    expect(shownA).toMatchObject({
      dispatch: { status: 'dispatched', task_id: workerA.taskId },
      worker: {
        agent_terminal_handle: workerA.handle,
        worktree_id: remoteWorktree.id,
        state: 'ready'
      },
      observation: { status: 'live', exactWorker: true },
      terminal: { handle: workerA.handle }
    })
    expect(shownA.remoteRuntimeEpoch).toBeTruthy()
    const remoteA = (
      await remote.call<RemoteAttachmentShow>('orchestration.federationShow', {
        dispatchId: workerA.dispatchId
      })
    ).result
    expect(remoteA).toMatchObject({
      attachment: {
        terminal_handle: workerA.handle,
        worktree_id: remoteWorktree.id
      },
      terminal: { handle: workerA.handle },
      observation: { exactWorker: true }
    })
    expect(['live', 'running']).toContain(remoteA.observation.status)
    expect(remoteA.attachment.pane_key).toBeTruthy()
    expect(remoteA.attachment.process_incarnation).toBeTruthy()
    expect(remoteA.attachment.capability_hash).toMatch(/^[a-f0-9]{64}$/)

    const baseDone = {
      taskId: workerA.taskId,
      dispatchId: workerA.dispatchId
    }
    await remote.call('terminal.send', {
      terminal: workerA.handle,
      text: `STA4593_DONE:${encodeMarker({ ...baseDone, mismatch: true })}`,
      enter: true
    })
    await waitForWorkerText(local, workerA.dispatchId, 'STA4593_DONE_RESULT|mismatch|')
    expect(
      (
        await local.call<{ dispatch: { status: string } }>('orchestration.dispatchShow', {
          task: workerA.taskId
        })
      ).result.dispatch.status
    ).toBe('dispatched')

    await remote.call('terminal.send', {
      terminal: workerA.handle,
      text: `STA4593_DONE:${encodeMarker({ ...baseDone, mismatch: false, nonce: 1 })}`,
      enter: true
    })
    await expect
      .poll(async () => {
        const dispatch = await local.call<{ dispatch: { status: string } }>(
          'orchestration.dispatchShow',
          { task: workerA.taskId }
        )
        return dispatch.result.dispatch.status
      })
      .toBe('completed')
    await remote.call('terminal.send', {
      terminal: workerA.handle,
      text: `STA4593_DONE:${encodeMarker({ ...baseDone, mismatch: false, nonce: 2 })}`,
      enter: true
    })
    await expect
      .poll(() => readLedger().filter((entry) => entry.event === 'worker_done'))
      .toHaveLength(3)
    const doneEntries = readLedger().filter((entry) => entry.event === 'worker_done')
    expect(doneEntries.map((entry) => entry.status)).toEqual([1, 0, 1])
    const completedTasks = (
      await local.call<{ tasks: { id: string; status: string }[] }>('orchestration.taskList', {
        run: workerA.runId
      })
    ).result.tasks.filter((task) => task.id === workerA.taskId)
    expect(completedTasks).toHaveLength(1)
    expect(completedTasks[0]).toMatchObject({ id: workerA.taskId, status: 'completed' })

    const workerB = await startWorker('B')
    const baseDoneB = {
      taskId: workerB.taskId,
      dispatchId: workerB.dispatchId
    }
    await remote.call('terminal.send', {
      terminal: workerB.handle,
      text: `STA4593_DONE:${encodeMarker({ ...baseDoneB, mismatch: false, nonce: 1 })}`,
      enter: true
    })
    await expect
      .poll(() => readLedger().filter((entry) => entry.event === 'worker_done'))
      .toHaveLength(4)
    const finalMarker = `b_${randomUUID().replaceAll('-', '')}`
    await remote.call('terminal.send', {
      terminal: workerB.handle,
      text: `STA4593_EXIT:${finalMarker}`,
      enter: true
    })
    await expect.poll(() => readLedger().some((entry) => entry.event === 'exit_marker')).toBe(true)
    const readBBeforeClose = await waitForWorkerText(
      local,
      workerB.dispatchId,
      `STA4593_STDOUT|${finalMarker}|FINAL`
    )
    if (readBBeforeClose.source !== 'terminal') {
      throw new Error('Worker B did not use terminal output')
    }
    expect(readBBeforeClose.terminal.tail.join('\n')).toContain(
      `STA4593_STDERR|${finalMarker}|FINAL`
    )
    // The fake worker has exited; close only its now-idle owning shell so the PTY itself settles.
    await remote.call('terminal.send', { terminal: workerB.handle, text: 'exit', enter: true })
    let shownB: WorkerShow | null = null
    await expect
      .poll(async () => {
        shownB = (
          await local.call<WorkerShow>('orchestration.workerShow', {
            dispatch: workerB.dispatchId
          })
        ).result
        return shownB.observation.status
      })
      .toBe('exited')
    const exitedB = (
      await local.call<WorkerShow>('orchestration.workerShow', { dispatch: workerB.dispatchId })
    ).result
    expect(exitedB.observation.status).toBe('exited')
    expect(exitedB.terminal).toMatchObject({ handle: workerB.handle, connected: false })
    const remoteExit = await remote.call<{ wait: RuntimeTerminalWait }>('terminal.wait', {
      terminal: workerB.handle,
      for: 'exit',
      timeoutMs: 10_000
    })
    expect(remoteExit.result.wait).toMatchObject({
      status: 'exited',
      satisfied: true,
      exitCode: 23
    })
    expect(readLedger().some((entry) => entry.event === 'exit_marker')).toBe(true)
    const readBAfterClose = await local
      .call<OrchestrationWorkerReadResult>('orchestration.workerRead', {
        dispatch: workerB.dispatchId,
        source: 'terminal',
        limit: 500
      })
      .then((response) => response.result)
      .catch(() => null)
    expect.soft(readBAfterClose).toMatchObject({ source: 'terminal' })
    if (readBAfterClose?.source === 'terminal') {
      const finalOutputPresent = readBAfterClose.terminal.tail
        .join('\n')
        .includes(`STA4593_STDOUT|${finalMarker}|FINAL`)
      test.info().annotations.push({
        type: 'sta4593-final-output-after-close',
        description: finalOutputPresent ? 'present' : 'missing'
      })
      if (supportsFederatedRelease || expectFederatedRelease) {
        expect(finalOutputPresent).toBe(true)
      }
      expect(readBAfterClose.terminal.status).toBe('exited')
      if (supportsFederatedRelease || expectFederatedRelease) {
        expect(readBAfterClose.terminal.exitCode).toBe(23)
        expect(readBAfterClose.terminal.command).toContain('codex')
        expect(readBAfterClose.terminal.oldestCursor).toMatch(/^\d+$/)
        expect(readBAfterClose.terminal.latestCursor).toMatch(/^[1-9]\d*$/)
        expect(readBAfterClose.terminal.nextCursor).toBe(readBAfterClose.terminal.latestCursor)
      }
    }

    const control = await remote.call<{ terminal: { handle: string } }>('terminal.create', {
      worktree: `id:${remoteWorktree.id}`,
      command: 'bash',
      title: 'STA-4593 unrelated control PTY',
      presentation: 'background'
    })
    const controlHandle = control.result.terminal.handle
    createdHandles.push(controlHandle)
    const retained = await local.call<{
      state: string
      reason?: string
      archive: unknown
    }>('orchestration.workerRetain', { dispatch: workerB.dispatchId })
    expect(retained.result.state).toBe('retained')
    if (supportsFederatedRelease) {
      expect(retained.result.reason).toBe('user_requested')
    } else {
      expect(['federation_unsupported', 'no_owned_resource']).toContain(retained.result.reason)
    }
    const released = await local.call<{
      state: string
      processAction: string
      archive: { source: string | null; status: string | null } | null
    }>('orchestration.workerRelease', { dispatch: workerB.dispatchId })
    if (supportsFederatedRelease) {
      expect(released.result).toMatchObject({
        state: 'released',
        processAction: 'closed_exited_terminal',
        archive: { source: 'terminal', status: 'captured' }
      })
    } else {
      expect(released.result).toMatchObject({
        state: 'retained',
        processAction: 'none',
        reason: expect.stringMatching(/federation_unsupported|no_owned_resource/)
      })
    }
    const releasedAgain = await local.call<{ state: string; processAction: string }>(
      'orchestration.workerRelease',
      { dispatch: workerB.dispatchId }
    )
    if (supportsFederatedRelease) {
      expect(releasedAgain.result).toMatchObject({
        state: 'already_released',
        processAction: 'none'
      })
    } else {
      expect(releasedAgain.result).toMatchObject({
        state: 'retained',
        processAction: 'none',
        reason: expect.stringMatching(/federation_unsupported|no_owned_resource/)
      })
    }
    if (expectFederatedRelease) {
      expect(supportsFederatedRelease).toBe(true)
    }
    const archivedB = await local
      .call<OrchestrationWorkerReadResult>('orchestration.workerRead', {
        dispatch: workerB.dispatchId,
        source: 'terminal',
        limit: 500
      })
      .then((response) => response.result)
      .catch(() => null)
    if (supportsFederatedRelease) {
      expect(archivedB).toMatchObject({ source: 'terminal', archived: true })
      if (archivedB?.source !== 'terminal') {
        throw new Error('Released worker archive did not use terminal output')
      }
      expect(archivedB.terminal.tail.join('\n')).toContain(finalMarker)
    }

    const workerC = await startWorker('C')
    const stopped = await local.call<{
      state: string
      processAction: string
      alreadySettled: boolean
    }>('orchestration.workerStop', { dispatch: workerC.dispatchId })
    expect(stopped.result, JSON.stringify(stopped.result)).toMatchObject(
      supportsStopVerdict
        ? {
            state: 'stopped',
            processAction: 'closed_agent_terminal',
            alreadySettled: false
          }
        : {
            state: 'stop_unknown',
            processAction: 'none',
            alreadySettled: false
          }
    )
    const stoppedAgain = await local
      .call<{
        state: string
        processAction: string
        alreadySettled: boolean
      }>('orchestration.workerStop', { dispatch: workerC.dispatchId })
      .catch(() => null)
    if (supportsStopVerdict) {
      expect(stoppedAgain?.result).toMatchObject({
        state: 'stopped',
        processAction: 'none',
        alreadySettled: true
      })
    }
    const remoteTerminals = await remote.call<RuntimeTerminalListResult>('terminal.list', {})
    expect(
      remoteTerminals.result.terminals.some((terminal) => terminal.handle === controlHandle)
    ).toBe(true)
    if (supportsStopVerdict) {
      expect(
        remoteTerminals.result.terminals.some((terminal) => terminal.handle === workerC.handle)
      ).toBe(false)
    }
  } catch (error) {
    cleanupAttempted = true
    try {
      await closeCreatedTerminals(remote, createdHandles)
    } catch (cleanupError) {
      test.info().annotations.push({
        type: 'sta4593-cleanup-error',
        description: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      })
    }
    throw error
  } finally {
    if (!cleanupAttempted) {
      await closeCreatedTerminals(remote, createdHandles)
    }
  }
})
