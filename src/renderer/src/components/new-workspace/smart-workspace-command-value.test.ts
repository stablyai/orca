import { describe, expect, it } from 'vitest'
import {
  resolveSmartWorkspaceCommandValue,
  type SmartWorkspaceCommandRow
} from './smart-workspace-command-value'

function row(kind: SmartWorkspaceCommandRow['kind'], value: string): SmartWorkspaceCommandRow {
  return { kind, value }
}

describe('resolveSmartWorkspaceCommandValue', () => {
  it('keeps the current command value when the row still exists', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('use-name', 'use-name'), row('github', 'github-12')],
        isQueryStale: false,
        sourceIntent: null
      })
    ).toBe('github-12')
  })

  it('falls back to the first row when the current value is no longer rendered', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('use-name', 'use-name'), row('branch', 'branch-main')],
        isQueryStale: false,
        sourceIntent: null
      })
    ).toBe('use-name')
  })

  it('freezes the current arm while the query is ahead of debounced search', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('use-name', 'use-name'), row('github', 'github-12')],
        isQueryStale: true,
        sourceIntent: null
      })
    ).toBe('github-12')
  })

  it('falls back to typed-text when a frozen arm is no longer rendered', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('use-name', 'use-name'), row('github', 'github-99')],
        isQueryStale: true,
        sourceIntent: null
      })
    ).toBe('use-name')
  })

  it('falls back to the first provider row when stale with no typed-text', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('github', 'github-99')],
        isQueryStale: true,
        sourceIntent: null
      })
    ).toBe('github-99')
  })

  it('prefers matching source-intent rows once fresh results arrive', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name',
        rows: [row('use-name', 'use-name'), row('github', 'github-123')],
        isQueryStale: false,
        sourceIntent: 'github'
      })
    ).toBe('github-123')

    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name',
        rows: [row('use-name', 'use-name'), row('gitlab', 'gitlab-123')],
        isQueryStale: false,
        sourceIntent: 'gitlab'
      })
    ).toBe('gitlab-123')

    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name',
        rows: [row('use-name', 'use-name'), row('linear', 'linear-ENG-123')],
        isQueryStale: false,
        sourceIntent: 'linear'
      })
    ).toBe('linear-ENG-123')

    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'jira-account-site-1',
        rows: [row('jira-account', 'jira-account-site-1'), row('jira', 'jira-ORCA-123')],
        isQueryStale: false,
        sourceIntent: 'jira'
      })
    ).toBe('jira-ORCA-123')
  })

  it('leaves the current value alone when no rows are rendered', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [],
        isQueryStale: false,
        sourceIntent: null
      })
    ).toBe('github-12')
  })
})
