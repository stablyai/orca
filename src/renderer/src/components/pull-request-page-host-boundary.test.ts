import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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

describe('PullRequestPage host boundaries', () => {
  it('routes reviewer metadata and mutations through the PR repo owner host', () => {
    const source = componentSource('PullRequestPage.tsx')
    const section = sourceBetween(source, 'function PRReviewersPanel', 'function isPRFileViewed')

    expect(section).toContain('getSettingsForRepoRuntimeOwner(s, item.repoId ?? null)')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('repoOwnerSettings')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('repoOwnerSettings')
    expect(section).toContain('getActiveRuntimeTarget(repoOwnerSettings)')
  })

  it('routes PR edit metadata through the same repo owner host as mutations', () => {
    const source = componentSource('PullRequestPage.tsx')
    const section = sourceBetween(source, 'function GHEditSection', 'function GHCommentComposer')

    expect(section).toContain('getSettingsForRepoRuntimeOwner(s, item.repoId ?? repoId ?? null)')
    expect(section).toContain('useRepoLabels(')
    expect(section).toContain('useRepoLabelsBySlug(slugOwner, slugRepo, repoOwnerSettings)')
    expect(section).toContain('useRepoAssignees(')
    expect(section).toContain('useRepoAssigneesBySlug(')
    expect(section).toContain('repoOwnerSettings')
  })

  it('routes PR mention metadata through the PR repo owner host', () => {
    const source = componentSource('PullRequestPage.tsx')
    const section = sourceBetween(source, 'function ConversationTab', 'const mentionOptions')

    expect(section).toContain('getSettingsForRepoRuntimeOwner(s, item.repoId ?? repoId ?? null)')
    expect(section).toContain('useRepoAssignees(repoPath, item.repoId, repoOwnerSettings)')
  })
})
