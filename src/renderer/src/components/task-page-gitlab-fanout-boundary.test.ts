import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASK_PAGE_SOURCE = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')

function sourceBetween(startPattern: string, endPattern: string): string {
  const start = TASK_PAGE_SOURCE.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = TASK_PAGE_SOURCE.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return TASK_PAGE_SOURCE.slice(start, end)
}

describe('TaskPage GitLab request fanout', () => {
  it('bounds per-repository requests without replacing all-settled handling', () => {
    const section = sourceBetween(
      '// Why: fetch GitLab Issues and MRs separately',
      '// Why: Todos fetch has its own effect'
    )

    expect(TASK_PAGE_SOURCE).toContain('const GITLAB_REPO_FETCH_CONCURRENCY = 8')
    expect(section).toContain('mapSettledWithConcurrency(')
    expect(section).toContain('GITLAB_REPO_FETCH_CONCURRENCY')
    expect(section).toContain('return fetchItems(repo)')
    expect(section).not.toContain('Promise.allSettled(eligibleRepos.map(fetchItems))')
    expect(section).toContain("if (r.status !== 'fulfilled')")
  })
})
