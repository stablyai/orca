// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitHubProjectRow } from '../../../../shared/github-project-types'
import { buildProjectWorkItem } from './ProjectViewWrapper'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('ProjectViewWrapper GitHub source context boundary', () => {
  it('builds project work items with a host-pinned repository identity', () => {
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

    expect(buildProjectWorkItem(row, 'repo-1', 'ghe.example.com')).toMatchObject({
      repoId: 'repo-1',
      type: 'pr',
      prRepo: { owner: 'acme', repo: 'orca', host: 'ghe.example.com' }
    })
    expect(buildProjectWorkItem(row, 'repo-1')?.prRepo?.host).toBe('github.com')
  })

  it('passes the matched repo source context into the repo-backed GitHub dialog', () => {
    const source = componentSource('ProjectViewWrapper.tsx')
    const contextSection = sourceBetween(
      source,
      'const resolvedDialogRepo = resolvedDialogRepoItem',
      'const resolvedMissingRepoDialogs'
    )
    const dialogSection = sourceBetween(source, '<GitHubItemDialog', 'onUse={(item) => {')

    expect(source).toContain('buildTaskSourceContextFromRepo')
    expect(contextSection).toContain("provider: 'github'")
    expect(contextSection).toContain('repo: resolvedDialogRepo')
    expect(dialogSection).toContain('sourceContext={resolvedDialogSourceContext}')
  })

  it('passes the exact project repository host through both direct launch paths', () => {
    const source = componentSource('ProjectViewWrapper.tsx')
    const rowLaunch = sourceBetween(source, 'const handleStartWork', 'const handleEditAssignees')
    const dialogLaunch = sourceBetween(
      source,
      'onUse={(item) => {',
      'onClose={() => setDialogRepoItem(null)}'
    )

    expect(rowLaunch).toContain('repoExecutionHostId: getRepoExecutionHostId(resolution.repo)')
    expect(dialogLaunch).toContain('repoExecutionHostId: current.workItem.repoExecutionHostId')
  })
})
