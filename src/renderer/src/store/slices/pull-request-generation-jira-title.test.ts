import { describe, expect, it } from 'vitest'
import {
  createRunningPullRequestGenerationRecord,
  resolvePullRequestGenerationSuccess
} from './pull-request-generation'

const context = {
  worktreeId: 'owned-worktree',
  worktreePath: '/repo/wt',
  repoId: 'owned-repo',
  branch: 'user/proj-7-fix-login',
  runtimeTarget: { kind: 'environment' as const, environmentId: 'ssh-owner' },
  requestId: 1,
  jiraIssueKey: 'PROJ-7'
}
const seed = { base: 'main', title: 'PROJ-7 Fix login', body: '', draft: false }
const revisions = { base: 0, title: 0, body: 0, draft: 0 }
const generated = { ...seed, title: 'proj-7 PROJ-7: Improve login', body: 'Generated' }

describe('background Jira title generation', () => {
  it.each([false, true])(
    'normalizes generated titles before storing or automatic submission (%s)',
    (autoSubmit) => {
      const record = createRunningPullRequestGenerationRecord(context, seed, revisions, autoSubmit)
      expect(
        resolvePullRequestGenerationSuccess({ record, requestId: 1, result: generated })?.result
          ?.title
      ).toBe('PROJ-7 Improve login')
    }
  )
  it.each([false, true])('preserves manually owned titles before generation (%s)', (autoSubmit) => {
    const record = createRunningPullRequestGenerationRecord(
      context,
      { ...seed, title: 'Exact manual title' },
      { ...revisions, title: 1 },
      autoSubmit
    )
    expect(
      resolvePullRequestGenerationSuccess({ record, requestId: 1, result: generated })?.result
        ?.title
    ).toBe('Exact manual title')
  })
  it('does not infer Jira identity from a branch without a Jira source', () => {
    const record = createRunningPullRequestGenerationRecord(
      { ...context, jiraIssueKey: null },
      seed,
      revisions,
      true
    )
    expect(
      resolvePullRequestGenerationSuccess({ record, requestId: 1, result: generated })?.result
        ?.title
    ).toBe(generated.title)
  })
})
