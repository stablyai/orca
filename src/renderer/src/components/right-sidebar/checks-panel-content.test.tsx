import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PRCheckDetail, PRComment, PRInfo } from '../../../../shared/types'
import {
  getFailedChecksForDetails,
  MergeConflictNotice,
  PRCommentsList,
  PRTriageStrip
} from './checks-panel-content'

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
  it('does not claim conflict details are refreshing after the refresh has settled', () => {
    const markup = renderNotice(makePR())

    expect(markup).toContain('Conflict file details are unavailable')
    expect(markup).not.toContain('Refreshing conflict details')
  })

  it('shows refreshing copy while conflict details are actively refreshing', () => {
    const markup = renderNotice(makePR(), true)

    expect(markup).toContain('Refreshing conflict details')
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
})

describe('PRCommentsList', () => {
  it('places the collapsed add-comment action after existing comments', () => {
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

    const markup = renderToStaticMarkup(
      React.createElement(PRCommentsList, {
        comments,
        commentsLoading: false,
        onAddComment: () => Promise.resolve({ ok: true as const })
      })
    )

    expect(markup.indexOf('Existing review context')).toBeLessThan(markup.indexOf('Add Comment'))
    expect(markup).not.toContain('Add a PR comment')
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
