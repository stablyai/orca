import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../shared/types'
import { MergeConflictNotice } from './checks-panel-content'

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
    React.createElement(MergeConflictNotice, { pr, isRefreshingConflictDetails })
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
})
