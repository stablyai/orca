import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import type { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalCreate } from '../../src/shared/runtime-types'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

type DispatchShowResult = {
  dispatch: { id: string; run_id: string; status: string } | null
}

test('isolates dispatch-show across Runs on a paired headless host', async ({ testRepoPath }) => {
  test.setTimeout(120_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const terminalA = await createTerminal(host.client, testRepoPath, 'Run A coordinator')
    const terminalB = await createTerminal(host.client, testRepoPath, 'Run B coordinator')
    const runA = await createRun(host.client, terminalA.handle, 'Run A')
    const runB = await createRun(host.client, terminalB.handle, 'Run B')
    const taskA = await createDispatchedTask(host.client, runA, terminalA.handle, 'Run A task')
    const taskB = await createDispatchedTask(host.client, runB, terminalB.handle, 'Run B task')

    const ownA = show(host.offer.pairingUrl, testRepoPath, terminalA, taskA)
    const ownB = show(host.offer.pairingUrl, testRepoPath, terminalB, taskB)
    const foreign = show(host.offer.pairingUrl, testRepoPath, terminalA, taskB)
    const absent = show(host.offer.pairingUrl, testRepoPath, terminalA, 'task_absent')

    expect(ownA.dispatch).toMatchObject({ run_id: runA, status: 'dispatched' })
    expect(ownB.dispatch).toMatchObject({ run_id: runB, status: 'dispatched' })
    expect(foreign).toEqual({ dispatch: null })
    expect(foreign).toEqual(absent)
    expect(show(host.offer.pairingUrl, testRepoPath, terminalB, taskB)).toEqual(ownB)
  } finally {
    await host.dispose()
  }
})

async function createTerminal(
  client: RuntimeClient,
  worktreePath: string,
  title: string
): Promise<RuntimeTerminalCreate> {
  const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `path:${worktreePath}`,
    title
  })
  if (!created.result.terminal.paneKey) {
    throw new Error('Headless terminal did not expose a stable pane identity')
  }
  return created.result.terminal
}

async function createRun(
  client: RuntimeClient,
  handle: string,
  objective: string
): Promise<string> {
  const created = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective,
    from: handle
  })
  return created.result.run.id
}

async function createDispatchedTask(
  client: RuntimeClient,
  run: string,
  handle: string,
  spec: string
): Promise<string> {
  const created = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
    run,
    spec,
    callerTerminalHandle: handle
  })
  await client.call('orchestration.dispatch', {
    task: created.result.task.id,
    run,
    from: handle,
    to: handle
  })
  return created.result.task.id
}

function show(
  pairingUrl: string,
  userDataPath: string,
  terminal: RuntimeTerminalCreate,
  task: string
): DispatchShowResult {
  const result = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), 'out', 'cli', 'index.js'),
      'orchestration',
      'dispatch-show',
      '--task',
      task,
      '--json'
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_DEV_CLI_INVOCATION: '1',
        ORCA_PAIRING_CODE: pairingUrl,
        ORCA_PANE_KEY: terminal.paneKey ?? '',
        ORCA_TERMINAL_HANDLE: terminal.handle,
        ORCA_USER_DATA_PATH: userDataPath
      }
    }
  )
  if (result.status !== 0) {
    throw new Error(`dispatch-show failed: ${result.stderr || result.stdout}`)
  }
  const response = JSON.parse(result.stdout) as { result: DispatchShowResult }
  return response.result
}
