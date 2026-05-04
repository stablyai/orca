import { branchName } from '@/lib/git-utils'
import type { Repo, Worktree } from '../../../shared/types'

export type MatchRange = { start: number; end: number }

export type PaletteMatchedField = 'displayName' | 'branch' | 'repo' | 'comment' | 'pr' | 'issue'

export type PaletteSupportingText = {
  label: 'Comment' | 'PR' | 'Issue'
  text: string
  matchRange: MatchRange | null
}

export type PaletteSearchResult = {
  worktreeId: string
  matchedField: PaletteMatchedField | null
  displayNameRange: MatchRange | null
  branchRange: MatchRange | null
  repoRange: MatchRange | null
  supportingText: PaletteSupportingText | null
}

type PRCacheEntry = { data?: { number: number; title: string } | null } | undefined
type IssueCacheEntry = { data?: { number: number; title: string } | null } | undefined

function extractCommentSnippet(
  comment: string,
  matchStart: number,
  matchEnd: number
): { text: string; matchRange: MatchRange } {
  let snippetStart = Math.max(0, matchStart - 40)
  let snippetEnd = Math.min(comment.length, matchEnd + 40)

  for (let i = 0; i < 10 && snippetStart > 0; i++) {
    if (/\s/.test(comment[snippetStart - 1])) {
      break
    }
    snippetStart--
  }
  for (let i = 0; i < 10 && snippetEnd < comment.length; i++) {
    if (/\s/.test(comment[snippetEnd])) {
      break
    }
    snippetEnd++
  }

  const prefix = snippetStart > 0 ? '\u2026' : ''
  const suffix = snippetEnd < comment.length ? '\u2026' : ''
  return {
    text: `${prefix}${comment.slice(snippetStart, snippetEnd)}${suffix}`,
    matchRange: {
      start: prefix.length + matchStart - snippetStart,
      end: prefix.length + matchEnd - snippetStart
    }
  }
}

function makeResult(
  worktreeId: string,
  matchedField: PaletteMatchedField | null,
  overrides: Partial<Omit<PaletteSearchResult, 'worktreeId' | 'matchedField'>> = {}
): PaletteSearchResult {
  return {
    worktreeId,
    matchedField,
    displayNameRange: null,
    branchRange: null,
    repoRange: null,
    supportingText: null,
    ...overrides
  }
}

export function searchWorktrees(
  worktrees: Worktree[],
  query: string,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  issueCache: Record<string, IssueCacheEntry> | null
): PaletteSearchResult[] {
  if (!query) {
    return worktrees.map((worktree) => makeResult(worktree.id, null))
  }

  const q = query.toLowerCase()
  const numericQuery = q.startsWith('#') ? q.slice(1) : q
  const results: PaletteSearchResult[] = []

  // Support "repo/worktree" composite queries (e.g. "orca/main") so users can
  // narrow by repo and worktree in a single token. Worktrees are identified by
  // their branch name here, so the right-hand side is matched against the
  // branch. We split on the FIRST slash only — branch names themselves contain
  // slashes (e.g. "feature/foo"), and we still want the right-hand side to
  // match those in full.
  const slashIndex = q.indexOf('/')
  const composite =
    slashIndex > 0 && slashIndex < q.length - 1
      ? { repoPart: q.slice(0, slashIndex), branchPart: q.slice(slashIndex + 1) }
      : null

  for (const worktree of worktrees) {
    if (composite) {
      const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
      const branch = branchName(worktree.branch)
      const repoIdx = repoName.toLowerCase().indexOf(composite.repoPart)
      const branchIdx = branch.toLowerCase().indexOf(composite.branchPart)
      if (repoIdx !== -1 && branchIdx !== -1) {
        results.push(
          makeResult(worktree.id, 'branch', {
            repoRange: { start: repoIdx, end: repoIdx + composite.repoPart.length },
            branchRange: { start: branchIdx, end: branchIdx + composite.branchPart.length }
          })
        )
        continue
      }
      // Fall through to single-token matching so users who type a branch name
      // that happens to contain a slash (e.g. "feature/foo") still get hits.
    }

    const nameIndex = worktree.displayName.toLowerCase().indexOf(q)
    if (nameIndex !== -1) {
      results.push(
        makeResult(worktree.id, 'displayName', {
          displayNameRange: { start: nameIndex, end: nameIndex + q.length }
        })
      )
      continue
    }

    const branch = branchName(worktree.branch)
    const branchIndex = branch.toLowerCase().indexOf(q)
    if (branchIndex !== -1) {
      results.push(
        makeResult(worktree.id, 'branch', {
          branchRange: { start: branchIndex, end: branchIndex + q.length }
        })
      )
      continue
    }

    const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
    const repoIndex = repoName.toLowerCase().indexOf(q)
    if (repoIndex !== -1) {
      results.push(
        makeResult(worktree.id, 'repo', {
          repoRange: { start: repoIndex, end: repoIndex + q.length }
        })
      )
      continue
    }

    if (worktree.comment) {
      const commentIndex = worktree.comment.toLowerCase().indexOf(q)
      if (commentIndex !== -1) {
        const snippet = extractCommentSnippet(
          worktree.comment,
          commentIndex,
          commentIndex + q.length
        )
        results.push(
          makeResult(worktree.id, 'comment', {
            supportingText: {
              label: 'Comment',
              text: snippet.text,
              matchRange: snippet.matchRange
            }
          })
        )
        continue
      }
    }

    if (!numericQuery) {
      continue
    }

    const repo = repoMap.get(worktree.repoId)
    const prKey = repo ? `${repo.path}::${branch}` : ''
    const pr = prKey && prCache ? prCache[prKey]?.data : undefined

    if (pr) {
      const prText = `PR #${pr.number}`
      const prNumberIndex = String(pr.number).indexOf(numericQuery)
      if (prNumberIndex !== -1) {
        results.push(
          makeResult(worktree.id, 'pr', {
            supportingText: {
              label: 'PR',
              text: prText,
              matchRange: {
                start: 'PR #'.length + prNumberIndex,
                end: 'PR #'.length + prNumberIndex + numericQuery.length
              }
            }
          })
        )
        continue
      }

      const prTitleIndex = pr.title.toLowerCase().indexOf(q)
      if (prTitleIndex !== -1) {
        results.push(
          makeResult(worktree.id, 'pr', {
            supportingText: {
              label: 'PR',
              text: pr.title,
              matchRange: { start: prTitleIndex, end: prTitleIndex + q.length }
            }
          })
        )
        continue
      }
    } else if (worktree.linkedPR != null) {
      const prText = `PR #${worktree.linkedPR}`
      const prNumberIndex = String(worktree.linkedPR).indexOf(numericQuery)
      if (prNumberIndex !== -1) {
        results.push(
          makeResult(worktree.id, 'pr', {
            supportingText: {
              label: 'PR',
              text: prText,
              matchRange: {
                start: 'PR #'.length + prNumberIndex,
                end: 'PR #'.length + prNumberIndex + numericQuery.length
              }
            }
          })
        )
        continue
      }
    }

    if (worktree.linkedIssue == null) {
      continue
    }

    const issueText = `Issue #${worktree.linkedIssue}`
    const issueNumberIndex = String(worktree.linkedIssue).indexOf(numericQuery)
    if (issueNumberIndex !== -1) {
      results.push(
        makeResult(worktree.id, 'issue', {
          supportingText: {
            label: 'Issue',
            text: issueText,
            matchRange: {
              start: 'Issue #'.length + issueNumberIndex,
              end: 'Issue #'.length + issueNumberIndex + numericQuery.length
            }
          }
        })
      )
      continue
    }

    const issueKey = repo ? `${repo.path}::${worktree.linkedIssue}` : ''
    const issue = issueKey && issueCache ? issueCache[issueKey]?.data : undefined
    if (!issue?.title) {
      continue
    }

    const issueTitleIndex = issue.title.toLowerCase().indexOf(q)
    if (issueTitleIndex !== -1) {
      results.push(
        makeResult(worktree.id, 'issue', {
          supportingText: {
            label: 'Issue',
            text: issue.title,
            matchRange: { start: issueTitleIndex, end: issueTitleIndex + q.length }
          }
        })
      )
    }
  }

  return results
}
