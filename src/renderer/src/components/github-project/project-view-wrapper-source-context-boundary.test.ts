import { describe, expect, it } from 'vitest'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'

describe('ProjectViewWrapper GitHub source context boundary', () => {
  it('builds project work items with a host-pinned repository identity', async () => {
    const { buildProjectWorkItem } = await import('./project-work-item')
    const row: GitHubProjectRow = {
      id: 'PVTI_1',
      itemType: 'PULL_REQUEST',
      content: {
        number: 42,
        title: 'Enterprise pull request',
        body: null,
        url: 'https://ghe.example.com/acme/orca/pull/42',
        state: 'OPEN',
        stateReason: null,
        isDraft: false,
        repository: 'acme/orca',
        assignees: [],
        labels: [{ name: 'bug', color: 'd73a4a' }],
        parentIssue: null,
        issueType: null
      },
      fieldValuesByFieldId: {},
      updatedAt: '2026-07-16T00:00:00.000Z',
      position: 0
    }

    const sshTwin = { id: 'repo-1', connectionId: 'builder' }
    expect(buildProjectWorkItem(row, sshTwin, 'ghe.example.com')).toMatchObject({
      repoId: 'repo-1',
      // Why: the slug-matched row's host, so a twin id never reaches the other host's row.
      repoHostId: 'ssh:builder',
      type: 'pr',
      assignees: [],
      prRepo: { owner: 'acme', repo: 'orca', host: 'ghe.example.com' }
    })
    expect(buildProjectWorkItem(row, { id: 'repo-1' })?.prRepo?.host).toBe('github.com')
  })

  it('threads the matched repo source context into direct start assignment', () => {
    const actionSource = componentSource('useProjectRowActions.ts')
    const wrapperSource = componentSource('ProjectViewWrapper.tsx')
    const startSection = sourceBetween(actionSource, 'const startWork = useCallback(', 'return {')
    const onUseSection = sourceBetween(wrapperSource, 'onUse={(item) => {', 'onClose=')

    expect(startSection).toContain('sourceContext: buildTaskSourceContextFromRepo({')
    expect(startSection).toContain('repo: resolution.repo')
    expect(onUseSection).toContain('sourceContext: rowActions.dialogSourceContext')
  })
})
