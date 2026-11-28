import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../github/work-items/work-item-types'
import {
  findSmartWorkspaceBranchIntentRef,
  resolveSmartWorkspaceCommandValue,
  type SmartWorkspaceCommandRow
} from './smart-workspace-command-value'
import { buildSmartWorkspaceSourceRows } from './smart-workspace-source-results'

describe('Branch intent resolution (#18701)', () => {
  const LIMIT = 12

  function branch(refName: string, localBranchName = refName) {
    return { refName, localBranchName }
  }

  function row(kind: SmartWorkspaceCommandRow['kind'], value: string): SmartWorkspaceCommandRow {
    return { kind, value }
  }

  it('picks exact matches or a unique prefix while treating local+remote aliases as one branch', () => {
    expect(
      findSmartWorkspaceBranchIntentRef('main', [branch('main-old'), branch('main')], LIMIT)
    ).toBe('main')
    expect(
      findSmartWorkspaceBranchIntentRef(
        'origin/main',
        [branch('refs/remotes/origin/main', 'main')],
        LIMIT
      )
    ).toBe('refs/remotes/origin/main')
    expect(
      findSmartWorkspaceBranchIntentRef(
        'origin/ma',
        [branch('refs/remotes/origin/main', 'main')],
        LIMIT
      )
    ).toBe('refs/remotes/origin/main')
    expect(findSmartWorkspaceBranchIntentRef('TV', [branch('TV-foo-bar')], LIMIT)).toBe(
      'TV-foo-bar'
    )
    expect(
      findSmartWorkspaceBranchIntentRef(
        'TV',
        [branch('TV-foo-bar'), branch('refs/remotes/origin/TV-foo-bar', 'TV-foo-bar')],
        LIMIT
      )
    ).toBe('TV-foo-bar')
  })

  it('keeps typed text when prefix is ambiguous, absent, case-mismatched, or from a full page', () => {
    expect(
      findSmartWorkspaceBranchIntentRef('TV', [branch('TV-foo-bar'), branch('TV-baz')], LIMIT)
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef(
        'feat',
        [
          branch('refs/remotes/origin/feature', 'feature'),
          branch('refs/remotes/upstream/feature', 'feature')
        ],
        LIMIT
      )
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef(
        'feat',
        [
          branch('refs/remotes/team/origin/feature', 'feature'),
          branch('refs/remotes/team/upstream/feature', 'feature')
        ],
        LIMIT
      )
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef(
        'feature',
        [
          branch('refs/remotes/origin/feature', 'feature'),
          branch('refs/remotes/upstream/feature', 'feature')
        ],
        LIMIT
      )
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef('TV', [branch('feature/TV-foo-bar')], LIMIT)
    ).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('  ', [branch('TV-foo-bar')], LIMIT)).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('tv', [branch('TV-foo-bar/tv')], LIMIT)).toBeNull()

    const fullPage = [
      branch('TV-foo-bar'),
      ...Array.from({ length: LIMIT - 1 }, (_, index) => branch(`x/TV-${index}`))
    ]
    expect(findSmartWorkspaceBranchIntentRef('TV', fullPage, LIMIT)).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('TV-foo-bar', fullPage, LIMIT)).toBe('TV-foo-bar')
  })

  it('arms branchIntentValue only when query is settled', () => {
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

  it('reserves a row within the smart-mode cap for a unique branch intent', () => {
    const githubItems: GitHubWorkItem[] = Array.from({ length: LIMIT }, (_, index) => ({
      id: `gh-${index + 1}`,
      repoId: 'repo-1',
      type: 'issue',
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: 'open',
      url: `https://github.com/stablyai/orca/issues/${index + 1}`,
      labels: [],
      updatedAt: '2026-11-18T00:00:00Z',
      author: null
    }))
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'smart',
      value: 'origin/TV',
      branches: [{ refName: 'refs/remotes/origin/TV-foo-bar', localBranchName: 'TV-foo-bar' }],
      githubItems,
      gitlabItems: [],
      linearIssues: [],
      gitlabAvailable: false,
      linearAvailable: false,
      resultLimit: LIMIT
    })

    expect(rows).toHaveLength(LIMIT + 1)
    expect(rows[0]).toMatchObject({ kind: 'use-name', value: 'use-name' })
    expect(
      rows.some(
        (entry) => entry.kind === 'branch' && entry.refName === 'refs/remotes/origin/TV-foo-bar'
      )
    ).toBe(true)
  })
})
