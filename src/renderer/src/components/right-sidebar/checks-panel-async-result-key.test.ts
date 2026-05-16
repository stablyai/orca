import { describe, expect, it } from 'vitest'
import {
  checksPanelAsyncResultKey,
  shouldCommitChecksPanelAsyncResult
} from './checks-panel-async-result-key'

describe('checksPanelAsyncResultKey', () => {
  it('builds a stable repo-scoped key', () => {
    expect(checksPanelAsyncResultKey('repo-id', 'feature/test', 12)).toBe(
      'repo-id::feature/test::12'
    )
  })

  it('uses explicit none marker when PR is absent', () => {
    expect(checksPanelAsyncResultKey('repo-id', 'feature/test', null)).toBe(
      'repo-id::feature/test::none'
    )
  })
})

describe('shouldCommitChecksPanelAsyncResult', () => {
  it('suppresses stale async completions', () => {
    expect(
      shouldCommitChecksPanelAsyncResult(
        checksPanelAsyncResultKey('repo-id', 'feature/new', 99),
        checksPanelAsyncResultKey('repo-id', 'feature/old', 12)
      )
    ).toBe(false)
  })
})
