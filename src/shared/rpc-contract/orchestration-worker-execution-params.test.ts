import { expect, it } from 'vitest'
import { WorkerStartParams } from './orchestration-worker-start-params'

it('admits an existing undispatched task while refusing retry and actor reuse intent', () => {
  const request = {
    task: 'task-one',
    run: 'run-one',
    from: 'orca-session:owner',
    worktree: 'id:folder:task',
    agent: 'codex',
    model: 'test-model',
    effort: 'low',
    executionPolicy: {
      schema: 1,
      sourcePin: 'a'.repeat(40),
      accountFingerprint: `codex:${'b'.repeat(64)}`,
      model: 'test-model',
      effort: 'low',
      access: 'read-only',
      deadlineAt: 1_800_000_120_000
    }
  }
  expect(WorkerStartParams.safeParse(request).success).toBe(true)
  expect(WorkerStartParams.safeParse({ ...request, retryOf: 'old-dispatch' }).success).toBe(false)
  expect(WorkerStartParams.safeParse({ ...request, terminal: 'old-actor' }).success).toBe(false)
})
