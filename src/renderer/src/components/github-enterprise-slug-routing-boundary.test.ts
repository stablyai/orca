import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function componentSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('GitHub Enterprise slug routing boundaries', () => {
  it('keeps work-item URL hosts on TaskPage metadata and issue mutations', () => {
    const source = componentSource('TaskPage.tsx')
    const statusSection = sourceBetween(source, 'function GHStatusCell', 'function formatPRDelta')
    const assigneeSection = sourceBetween(
      source,
      'function GHAssigneesCell',
      'function getChecksLabel'
    )

    expect(statusSection).toContain('host: githubProjectHost(parsedOwnerRepo.host)')
    expect(assigneeSection).toContain('parsed?.slug.host')
    expect(assigneeSection).toContain('host: githubProjectHost(parsed?.slug.host)')
  })

  it('uses URL-host fallback for TaskPage reviewer and merge mutations', () => {
    const source = componentSource('TaskPage.tsx')
    const reviewSection = sourceBetween(source, 'function PRReviewCell', 'function PRChecksCell')
    const mergeSection = sourceBetween(source, 'function PRMergeCell', 'function getPageNumbers')

    expect(reviewSection).toContain('resolveTaskPullRequestRepo(item)')
    expect(reviewSection.match(/prRepo: reviewRepo/g)).toHaveLength(4)
    expect(mergeSection).toContain('const prRepo = resolveTaskPullRequestRepo(item)')
    expect(mergeSection).not.toContain('prRepo: item.prRepo ?? null')
  })

  it('keeps PR base-repository hosts on checks-sidebar comment writes', () => {
    const source = componentSource('right-sidebar/ChecksPanel.tsx')
    const conversationSection = sourceBetween(
      source,
      'const handleEditComment = useCallback',
      'const handleReplyToComment = useCallback'
    )

    expect(conversationSection).toContain('host: githubProjectHost(pr.prRepo.host)')
    expect(conversationSection).toContain('updateIssueCommentBySlug({')
    expect(conversationSection).toContain('deleteIssueCommentBySlug({')
  })

  it('keeps the primary repository host on task filter metadata reads', () => {
    const source = componentSource('github/PRFilterDropdowns.tsx')

    expect(source).toContain('useRepoLabelsBySlug(')
    expect(source).toContain('useRepoAssigneesBySlug(')
    expect(source.match(/primarySlug\?\.host/g)).toHaveLength(2)
  })
})
