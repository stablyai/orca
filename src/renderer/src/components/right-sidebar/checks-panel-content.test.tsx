import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRComment, PRInfo } from '../../../../shared/types'
import {
  buildMergeabilityRecalculationCommands,
  CheckJobLogTail,
  ChecksList,
  ConflictTriageStrip,
  getFailedChecksForDetails,
  MergeConflictNotice,
  isMutablePRConversationComment,
  PRCommentsList,
  PRTriageStrip
} from './checks-panel-content'

function renderWithTooltips(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(TooltipProvider, null, element))
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'Conflicting PR',
    state: 'open',
    url: 'https://github.com/acme/widgets/pull/42',
    checksStatus: 'pending',
    updatedAt: '2026-05-14T00:00:00Z',
    mergeable: 'CONFLICTING',
    ...overrides
  }
}

function renderNotice(pr: PRInfo, isRefreshingConflictDetails = false): string {
  return renderToStaticMarkup(
    React.createElement(MergeConflictNotice, {
      pr,
      isRefreshingConflictDetails
    })
  )
}

describe('MergeConflictNotice', () => {
  it('builds safe mergeability recalculation commands', () => {
    expect(buildMergeabilityRecalculationCommands()).toBe(
      [
        'git fetch origin',
        'git commit --allow-empty --only -m "chore: refresh PR mergeability"',
        'git push'
      ].join('\n')
    )
  })

  it('does not claim conflict details are refreshing after the refresh has settled', () => {
    const markup = renderNotice(makePR())

    expect(markup).toContain('Conflict file details are unavailable')
    expect(markup).not.toContain('Refreshing conflict details')
  })

  it('shows refreshing copy while conflict details are actively refreshing', () => {
    const markup = renderNotice(makePR(), true)

    expect(markup).toContain('Refreshing conflict details')
  })

  it('explains when the hosting provider reports conflicts but local git simulates a clean merge', () => {
    const markup = renderNotice(
      makePR({
        conflictSummary: {
          baseRef: 'main',
          baseCommit: 'abc1234',
          commitsBehind: 1,
          files: [],
          localMergeState: 'clean'
        }
      })
    )

    expect(markup).toContain('local Git did not reproduce them')
    expect(markup).toContain('Run from this worktree')
    expect(markup).toContain('hosting provider reports conflicts')
    expect(markup).toContain('git fetch origin')
    expect(markup).toContain('git commit --allow-empty --only')
    expect(markup).toContain('git push')
    expect(markup).toContain('Copy commands')
    expect(markup).not.toContain('Conflict file details are unavailable')
  })

  it('does not interpolate shell-sensitive base refs into copyable commands', () => {
    const markup = renderNotice(
      makePR({
        conflictSummary: {
          baseRef: 'release/$USER;echo unsafe',
          baseCommit: 'abc1234',
          commitsBehind: 1,
          files: [],
          localMergeState: 'clean'
        }
      })
    )

    expect(markup).toContain('git fetch origin')
    expect(markup).not.toContain('$USER')
    expect(markup).not.toContain('echo unsafe')
  })

  it('hides when the conflicting file list is available', () => {
    const markup = renderNotice(
      makePR({
        conflictSummary: {
          baseRef: 'main',
          baseCommit: 'abc1234',
          commitsBehind: 2,
          files: ['src/conflict.ts']
        }
      })
    )

    expect(markup).toBe('')
  })

  it('keeps the conflict details informational without a duplicate AI action', () => {
    const markup = renderNotice(makePR())

    expect(markup).not.toContain('Resolve with AI')
    expect(markup).not.toContain('lucide-sparkles')
  })

  it('renders the single conflict AI action in the triage strip', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PRTriageStrip, {
        pr: makePR(),
        checks: [],
        isResolvingConflictsWithAI: false,
        onResolveConflictsWithAI: () => {},
        isFixingChecksWithAI: false,
        onFixChecksWithAI: () => {}
      })
    )

    expect(markup).toContain('Resolve')
    expect(markup).toContain('lucide-sparkles')
    expect(markup).not.toContain('Resolve with AI')
  })

  it('renders a conflict resolve action for merge requests without PR data', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ConflictTriageStrip, {
        reviewKind: 'MR',
        isResolvingConflictsWithAI: false,
        onResolveConflictsWithAI: () => {}
      })
    )

    expect(markup).toContain('Conflicts block this MR')
    expect(markup).toContain('Resolve')
    expect(markup).toContain('lucide-sparkles')
  })

  it('renders the CI fix action for failing non-conflict checks', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PRTriageStrip, {
        review: makePR({ mergeable: 'MERGEABLE' }),
        checks: [{ name: 'verify', status: 'completed', conclusion: 'failure', url: null }],
        isResolvingConflictsWithAI: false,
        onResolveConflictsWithAI: () => {},
        isFixingChecksWithAI: false,
        onFixChecksWithAI: () => {}
      })
    )

    expect(markup).toContain('1 failing check')
    expect(markup).toContain('Fix')
    expect(markup).toContain('data-variant="outline"')
    expect(markup).toContain('lucide-sparkles')
    expect(markup).not.toContain('Fix with AI')
    expect(markup).not.toContain('Resolve')
  })
})

describe('ChecksList', () => {
  it('puts the hosted details link in the check row as an icon affordance', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChecksList, {
          checks: [
            {
              name: 'verify',
              status: 'completed',
              conclusion: 'failure',
              url: 'https://github.com/acme/widgets/actions/runs/1'
            }
          ],
          checksLoading: false,
          checkDetailsContextKey: 'repo:42',
          onLoadCheckDetails: async () => null
        })
      )
    )

    expect(markup).toContain('aria-label="Open check details"')
    expect(markup).toContain('lucide-external-link')
    expect(markup).toContain('Failed')
    expect(markup.indexOf('Failed')).toBeLessThan(markup.indexOf('aria-label="Open check details"'))
    expect(markup).toContain('text-muted-foreground')
    expect(markup).not.toContain('opacity-0')
    expect(markup).not.toContain('Open details')
  })
})

describe('isMutablePRConversationComment', () => {
  it('allows top-level conversation comments but not review threads or summaries', () => {
    expect(
      isMutablePRConversationComment({
        id: 12,
        author: 'alice',
        authorAvatarUrl: '',
        body: 'Looks good',
        createdAt: '2026-05-14T00:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-12'
      })
    ).toBe(true)
    expect(
      isMutablePRConversationComment({
        id: 34,
        author: 'alice',
        authorAvatarUrl: '',
        body: 'Inline note',
        createdAt: '2026-05-14T00:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#discussion_r34',
        threadId: 'thread-1',
        path: 'src/a.ts'
      })
    ).toBe(false)
    expect(
      isMutablePRConversationComment({
        id: 99,
        author: 'alice',
        authorAvatarUrl: '',
        body: 'LGTM',
        createdAt: '2026-05-14T00:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-99'
      })
    ).toBe(false)
  })
})

describe('PRCommentsList', () => {
  it('places the collapsed add-comment action in the comments header', () => {
    const comments: PRComment[] = [
      {
        id: 1,
        author: 'AmethystLiang',
        authorAvatarUrl: '',
        body: 'Existing review context',
        createdAt: '2026-05-14T00:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-1'
      }
    ]

    const markup = renderWithTooltips(
      React.createElement(PRCommentsList, {
        comments,
        commentsLoading: false,
        onAddComment: () => Promise.resolve({ ok: true as const })
      })
    )

    expect(markup.indexOf('aria-label="Add comment"')).toBeLessThan(
      markup.indexOf('Existing review context')
    )
    expect(markup).toContain('lucide-plus')
    expect(markup).not.toContain('Add a comment...')
    expect(markup).not.toContain('Add a PR comment')
  })

  it('renders a more-actions menu on conversation comments', () => {
    const comments: PRComment[] = [
      {
        id: 1,
        author: 'AmethystLiang',
        authorAvatarUrl: '',
        body: 'Existing review context',
        createdAt: '2026-05-14T00:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-1'
      }
    ]

    const markup = renderWithTooltips(
      React.createElement(PRCommentsList, {
        comments,
        commentsLoading: false,
        onEditComment: () => Promise.resolve(true),
        onDeleteComment: () => {}
      })
    )

    expect(markup).toContain('aria-label="More comment actions"')
    expect(markup).toContain('data-slot="dropdown-menu-trigger"')
  })

  it('uses the header plus action as the empty comments state', () => {
    const markup = renderWithTooltips(
      React.createElement(PRCommentsList, {
        comments: [],
        commentsLoading: false,
        onAddComment: () => Promise.resolve({ ok: true as const })
      })
    )

    expect(markup).toContain('aria-label="Start conversation"')
    expect(markup).toContain('lucide-plus')
    expect(markup).not.toContain('Start conversation...')
    expect(markup).not.toContain('No comments yet')
    expect(markup).not.toContain('Add a comment')
    expect((markup.match(/lucide-message-square/g) ?? []).length).toBe(1)
  })
})

describe('getFailedChecksForDetails', () => {
  it('selects failed, cancelled, and timed out checks for inline details', () => {
    const checks: PRCheckDetail[] = [
      { name: 'unit', status: 'completed', conclusion: 'success', url: null },
      { name: 'verify', status: 'completed', conclusion: 'failure', url: null },
      { name: 'lint', status: 'completed', conclusion: 'cancelled', url: null },
      { name: 'e2e', status: 'completed', conclusion: 'timed_out', url: null },
      { name: 'deploy', status: 'in_progress', conclusion: 'pending', url: null }
    ]

    expect(getFailedChecksForDetails(checks).map((check) => check.name)).toEqual([
      'verify',
      'lint',
      'e2e'
    ])
  })
})

describe('CheckJobLogTail', () => {
  it('renders a labeled monospace log tail with copy affordance', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CheckJobLogTail, {
        logTail: 'Error: expected true to be false'
      })
    )

    expect(markup).toContain('Log tail (last 200 lines)')
    expect(markup).toContain('Error: expected true to be false')
    expect(markup).toContain('Copy log tail')
  })
})
