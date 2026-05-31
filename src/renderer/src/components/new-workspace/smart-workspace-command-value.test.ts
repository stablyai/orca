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
        rows: [row('use-name', 'use-name-fix'), row('github', 'github-12')],
        isQueryStale: false,
        sourceIntent: null
      })
    ).toBe('github-12')
  })

  it('falls back to the first row when the current value is no longer rendered', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('use-name', 'use-name-fix'), row('branch', 'branch-main')],
        isQueryStale: false,
        sourceIntent: null
      })
    ).toBe('use-name-fix')
  })

  it('uses typed-text rows while source results are stale', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('use-name', 'use-name-fix'), row('github', 'github-12')],
        isQueryStale: true,
        sourceIntent: null
      })
    ).toBe('use-name-fix')
  })

  it('clears selection while stale source-only rows have no typed fallback', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('github', 'github-12')],
        isQueryStale: true,
        sourceIntent: null
      })
    ).toBe('')
  })

  it('prefers matching source-intent rows once fresh results arrive', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name-123',
        rows: [row('use-name', 'use-name-123'), row('github', 'github-123')],
        isQueryStale: false,
        sourceIntent: 'github'
      })
    ).toBe('github-123')

    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name-eng-123',
        rows: [row('use-name', 'use-name-eng-123'), row('linear', 'linear-ENG-123')],
        isQueryStale: false,
        sourceIntent: 'linear'
      })
    ).toBe('linear-ENG-123')
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
