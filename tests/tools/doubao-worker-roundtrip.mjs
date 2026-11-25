// From a built checkout with a signed-in Doubao CLI and a real coordinator in the named Run:
// node tests/tools/doubao-worker-roundtrip.mjs --from <handle> --run <run-id> --worktree <selector>
// Override account-specific selections with --model-a <id> --effort-a <level> --model-b <id> --effort-b <level>.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    run: { type: 'string' },
    worktree: { type: 'string' },
    'model-a': { type: 'string', default: '5' },
    'effort-a': { type: 'string', default: 'low' },
    'model-b': { type: 'string', default: '5101' },
    'effort-b': { type: 'string', default: 'high' }
  }
})
assert(values.from && values.run && values.worktree, 'Pass --from, --run and --worktree.')
assert(!['new-child', 'new-top-level'].includes(values.worktree), 'Specify an existing workspace.')
const cli = fileURLToPath(new URL('../../out/cli/index.js', import.meta.url))
const execute = promisify(execFile)
const deadline = Date.now() + 180_000
const identity = ['--from', values.from, '--run', values.run]
const workers = ['a', 'b'].map((key, index) => ({
  model: values[`model-${key}`],
  effort: values[`effort-${key}`],
  marker: `doubao-${key}-${randomUUID().slice(0, 8)}`,
  pieces: randomInt(11, 20),
  boxes: index === 0 ? 3 : 9
}))

async function orca(args, timeout = Math.min(80_000, deadline - Date.now())) {
  assert(timeout > 0, 'Timed out waiting for both Doubao workers.')
  const { stdout } = await execute(
    process.execPath,
    [cli, 'orchestration', ...args, '--full', '--json'],
    {
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    }
  )
  return JSON.parse(stdout).result
}

async function start(worker) {
  const spec = `Calculate ${worker.pieces} times ${worker.boxes}. In your worker_done report include exactly the reference ${worker.marker} followed by an equals sign and the numerical answer, without spaces. Do not edit files or start helpers.`
  const created = await orca([
    'task-create',
    ...identity,
    '--task-title',
    worker.marker,
    '--spec',
    spec
  ])
  worker.task = created.task.id
  const launched = await orca([
    'worker-start',
    ...identity,
    '--task',
    worker.task,
    '--agent',
    'doubao',
    '--worktree',
    values.worktree,
    '--model',
    worker.model,
    '--effort',
    worker.effort,
    '--timeout-ms',
    '65000'
  ])
  assert.equal(launched.taskId, worker.task)
  assert.equal(launched.run.id, values.run)
  worker.dispatch = launched.dispatchId
  assert(worker.dispatch)
  worker.terminal = launched.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'agent'
  )?.id
  assert(worker.terminal)
  assert.equal(launched.state, 'ready')
  assert.deepEqual(launched.launch.effective, {
    agent: 'doubao',
    model: worker.model,
    effort: worker.effort
  })
}

async function checkReports() {
  while (workers.some((worker) => !worker.report)) {
    const { messages } = await orca(['inbox', '--terminal', `run:${values.run}`, '--limit', '100'])
    for (const message of messages) {
      if (
        message.type !== 'worker_done' ||
        message.run_id !== values.run ||
        message.to_handle !== `run:${values.run}`
      ) {
        continue
      }
      const payload = JSON.parse(message.payload ?? 'null')
      const worker = workers.find((entry) => entry.dispatch === payload?.dispatchId)
      if (!worker) {
        continue
      }
      assert.equal(payload.taskId, worker.task)
      assert.equal(payload.outcome, 'succeeded')
      assert.equal(message.from_handle, worker.terminal)
      const expected = `${worker.marker}=${worker.pieces * worker.boxes}`
      assert(
        new RegExp(`${expected}(?![0-9])`).test(message.body),
        `Report ${message.id} omitted ${expected}.`
      )
      assert(
        !workers.some((other) => other !== worker && message.body.includes(other.marker)),
        'Worker reports crossed.'
      )
      worker.report = message.id
    }
    if (workers.some((worker) => !worker.report)) {
      await delay(1500)
    }
  }
  assert.notEqual(workers[0].report, workers[1].report)
}

async function cleanup(worker) {
  if (!worker.task) {
    return
  }
  if (!worker.dispatch) {
    // An interrupted start may have created its Dispatch before returning its receipt.
    const { dispatch } = await orca(['dispatch-show', '--task', worker.task], 10_000)
    if (!dispatch || dispatch.task_id !== worker.task) {
      return
    }
    worker.dispatch = dispatch.id
  }
  const action = worker.report ? 'worker-release' : 'worker-stop'
  const receipt = await orca([action, '--dispatch', worker.dispatch], 15_000)
  if (worker.report) {
    assert(
      ['released', 'already_released', 'release_pending'].includes(receipt.state),
      `Unexpected release state: ${receipt.state}`
    )
  }
}

try {
  const starts = await Promise.allSettled(workers.map(start))
  const failed = starts.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }
  assert.notEqual(workers[0].dispatch, workers[1].dispatch)
  assert.notEqual(workers[0].task, workers[1].task)
  assert.notEqual(workers[0].terminal, workers[1].terminal)
  await checkReports()
  console.log(JSON.stringify(workers, null, 2))
} finally {
  const released = await Promise.allSettled(workers.map(cleanup))
  for (const result of released) {
    if (result.status === 'rejected') {
      console.error(result.reason)
      process.exitCode = 1
    }
  }
}
