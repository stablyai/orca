import { test, expect } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import { waitForSessionReady, ensureTerminalVisible } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

test('low-level Dispatches can be abandoned and stopped without closing their pane', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  const resolved = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: pane.paneKey
  })
  const terminalHandle = resolved.result.terminal.handle
  await expect
    .poll(async () => (await findTerminal(client, terminalHandle)).incarnationId, {
      timeout: 15_000
    })
    .toBeTruthy()
  const before = await findTerminal(client, terminalHandle)
  if (!before.incarnationId) {
    throw new Error('The target terminal never published a process incarnation')
  }
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Release low-level Dispatches',
    from: terminalHandle
  })

  const abandonedTask = await createTask(client, run.result.run.id, terminalHandle, 'abandon')
  const abandonedDispatch = await dispatchTask(
    client,
    run.result.run.id,
    abandonedTask,
    terminalHandle
  )
  const shownBeforeAbandon = await showDispatch(client, abandonedTask)
  expect(shownBeforeAbandon.id).toBe(abandonedDispatch)
  expect(shownBeforeAbandon.status).toBe('dispatched')

  await expect(
    client.call('orchestration.workerAbandon', { dispatch: abandonedDispatch })
  ).resolves.toMatchObject({
    result: {
      dispatchId: abandonedDispatch,
      state: 'abandoned',
      alreadySettled: false,
      processAction: 'none'
    }
  })
  expect(await showDispatch(client, abandonedTask)).toMatchObject({
    status: 'failed',
    last_failure: 'abandoned'
  })

  const stoppedTask = await createTask(client, run.result.run.id, terminalHandle, 'stop')
  const stoppedDispatch = await dispatchTask(client, run.result.run.id, stoppedTask, terminalHandle)
  await expect(
    client.call('orchestration.workerStop', { dispatch: stoppedDispatch })
  ).resolves.toMatchObject({
    result: {
      dispatchId: stoppedDispatch,
      state: 'stopped',
      alreadySettled: false,
      processAction: 'none',
      warning: expect.stringContaining('without closing')
    }
  })
  expect(await showDispatch(client, stoppedTask)).toMatchObject({
    status: 'failed',
    last_failure: 'stopped'
  })

  const after = await findTerminal(client, terminalHandle)
  expect(after).toMatchObject({
    handle: before.handle,
    ptyId: before.ptyId,
    incarnationId: before.incarnationId,
    connected: true
  })

  const reusableTask = await createTask(client, run.result.run.id, terminalHandle, 'reuse')
  await expect(
    dispatchTask(client, run.result.run.id, reusableTask, terminalHandle)
  ).resolves.toMatch(/^ctx_/)
})

async function createTask(
  client: RuntimeClient,
  runId: string,
  coordinatorHandle: string,
  suffix: string
): Promise<string> {
  const created = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
    spec: `low-level ${suffix}`,
    run: runId,
    callerTerminalHandle: coordinatorHandle
  })
  return created.result.task.id
}

async function dispatchTask(
  client: RuntimeClient,
  runId: string,
  taskId: string,
  terminalHandle: string
): Promise<string> {
  const dispatched = await client.call<{ dispatch: { id: string } }>('orchestration.dispatch', {
    task: taskId,
    run: runId,
    from: terminalHandle,
    to: terminalHandle
  })
  return dispatched.result.dispatch.id
}

async function showDispatch(
  client: RuntimeClient,
  taskId: string
): Promise<{ id: string; status: string; last_failure: string | null }> {
  const shown = await client.call<{
    dispatch: { id: string; status: string; last_failure: string | null }
  }>('orchestration.dispatchShow', { task: taskId })
  return shown.result.dispatch
}

async function findTerminal(client: RuntimeClient, handle: string) {
  const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
  const terminal = listed.result.terminals.find((candidate) => candidate.handle === handle)
  expect(terminal).toBeDefined()
  return terminal!
}
