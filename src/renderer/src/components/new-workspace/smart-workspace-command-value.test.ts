import { describe, expect, it } from 'vitest'
import {
  findSmartWorkspaceBranchIntentRef,
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

  it('keeps arbitrary text armed when Linear search results are present', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: '',
        rows: [row('use-name', 'use-name'), row('linear', 'linear-STA-4084')],
        isQueryStale: false,
        sourceIntent: null
      })
    ).toBe('use-name')
  })

  it('keeps typed text armed while the query is ahead of debounced search', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'github-12',
        rows: [row('use-name', 'use-name'), row('github', 'github-12')],
        isQueryStale: true,
        sourceIntent: null
      })
    ).toBe('use-name')
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

  it('does not resurrect a provider arm when the stale query settles', () => {
    const rows = [row('use-name', 'use-name'), row('github', 'github-12')]
    const typedTextArm = resolveSmartWorkspaceCommandValue({
      currentValue: 'github-12',
      rows,
      isQueryStale: true,
      sourceIntent: null
    })

    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: typedTextArm,
        rows,
        isQueryStale: false,
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

  it('arms the named branch over the typed-text row once results settle', () => {
    const rows = [row('use-name', 'use-name'), row('branch', 'branch-TV-foo-bar')]
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name',
        rows,
        isQueryStale: false,
        sourceIntent: null,
        branchIntentValue: 'branch-TV-foo-bar'
      })
    ).toBe('branch-TV-foo-bar')

    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name',
        rows,
        isQueryStale: true,
        sourceIntent: null,
        branchIntentValue: 'branch-TV-foo-bar'
      })
    ).toBe('use-name')
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

describe('findSmartWorkspaceBranchIntentRef', () => {
  const LIMIT = 12

  function branch(refName: string, localBranchName = refName) {
    return { refName, localBranchName }
  }

  it('picks a branch the typed text names exactly', () => {
    expect(
      findSmartWorkspaceBranchIntentRef('main', [branch('main-old'), branch('main')], LIMIT)
    ).toBe('main')
    expect(
      findSmartWorkspaceBranchIntentRef('origin/main', [branch('origin/main', 'main')], LIMIT)
    ).toBe('origin/main')
  })

  it('picks the only branch the typed text prefixes, counting local and remote as one', () => {
    expect(findSmartWorkspaceBranchIntentRef('TV', [branch('TV-foo-bar')], LIMIT)).toBe(
      'TV-foo-bar'
    )
    expect(
      findSmartWorkspaceBranchIntentRef(
        'TV',
        [branch('TV-foo-bar'), branch('origin/TV-foo-bar', 'TV-foo-bar')],
        LIMIT
      )
    ).toBe('TV-foo-bar')
  })

  it('keeps the typed text when the prefix matches more than one branch', () => {
    expect(
      findSmartWorkspaceBranchIntentRef('TV', [branch('TV-foo-bar'), branch('TV-baz')], LIMIT)
    ).toBeNull()
  })

  it('keeps the typed text when no branch starts with it', () => {
    expect(
      findSmartWorkspaceBranchIntentRef('TV', [branch('feature/TV-foo-bar')], LIMIT)
    ).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('  ', [branch('TV-foo-bar')], LIMIT)).toBeNull()
    // Host ref search is case-sensitive, so a case-folded match could hide a sibling branch.
    expect(findSmartWorkspaceBranchIntentRef('tv', [branch('TV-foo-bar/tv')], LIMIT)).toBeNull()
  })

  it('does not trust a prefix when a full result page may hide another match', () => {
    const fullPage = [
      branch('TV-foo-bar'),
      ...Array.from({ length: LIMIT - 1 }, (_, i) => branch(`x/TV-${i}`))
    ]
    expect(findSmartWorkspaceBranchIntentRef('TV', fullPage, LIMIT)).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('TV-foo-bar', fullPage, LIMIT)).toBe('TV-foo-bar')
  })
})
