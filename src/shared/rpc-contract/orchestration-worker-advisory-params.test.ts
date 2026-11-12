import { expect, it } from 'vitest'
import { WorkerStartParams } from './orchestration-worker-start-params'

const consult = {
  from: 'owner',
  spec: 'one question',
  parent: 'owner-task',
  worktree: 'id:folder::advisor',
  agent: 'claude',
  model: 'test-model',
  effort: 'medium',
  advisoryPolicy: {
    schema: 1,
    dataScope: 'published',
    sourcePin: 'a'.repeat(40),
    deadlineAt: 1_800_000_300_000,
    maxModelCalls: 4,
    artifacts: [
      {
        path: 'note.txt',
        text: 'hello',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      }
    ]
  }
}

it('preserves the bounded policy on a new explicitly scoped consultation', () => {
  expect(WorkerStartParams.parse(consult).advisoryPolicy).toEqual(consult.advisoryPolicy)
})

it('refuses snapshots whose aggregate UTF-8 bytes exceed the limit before worker admission', () => {
  expect(
    WorkerStartParams.safeParse({
      ...consult,
      advisoryPolicy: {
        ...consult.advisoryPolicy,
        artifacts: consult.advisoryPolicy.artifacts.map((artifact) => ({
          ...artifact,
          text: 'é'.repeat(524_289)
        }))
      }
    }).success
  ).toBe(false)
})

it.each([
  { spec: undefined, task: 'existing' },
  { parent: undefined },
  { worktree: undefined },
  { worktree: 'current' },
  { worktree: 'new-child' },
  { on: 'remote' },
  { terminal: 'existing' },
  { adoptTaskId: 'existing' },
  { retryOf: 'prior' },
  { setup: 'run' },
  { agent: 'codex' },
  { model: undefined },
  { effort: undefined },
  { deps: '["unrelated"]' }
])('refuses advisory launch inheritance or unbound placement %j', (override) => {
  expect(WorkerStartParams.safeParse({ ...consult, ...override }).success).toBe(false)
})
