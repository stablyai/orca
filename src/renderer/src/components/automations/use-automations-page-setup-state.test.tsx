// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { useAutomationsPageSetupState } from './use-automations-page-setup-state'

type HookInput = Parameters<typeof useAutomationsPageSetupState>[0]

function cacheKeyFor(repos: Partial<Repo>[], focused: string | null, repoId = 'repo-1'): string {
  const { result } = renderHook(() =>
    useAutomationsPageSetupState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cache key reads only repos and settings.
      store: {
        repos,
        settings: { activeRuntimeEnvironmentId: focused },
        projectHostSetups: [],
        worktreesByRepo: {}
      } as unknown as HookInput['store'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inert for the cache key.
      local: {
        draft: { projectId: repoId },
        automationHostTargetKey: null,
        selectedAutomationRuns: { rowKey: null, ownerKey: null, notice: null },
        selectedAutomationRunPageId: null
      } as unknown as HookInput['local'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inert for the cache key.
      list: {
        selected: null,
        selectedRow: null,
        selectedAutomationRunsWithWorkspaceNames: [],
        capturedAutomationOwners: {},
        hostCatalog: { entries: [] }
      } as unknown as HookInput['list']
    })
  )
  return result.current.getAutomationHooksCacheKey(repoId)
}

describe('automation hooks cache key', () => {
  it.each<[string, Partial<Repo>[], string | null, string]>([
    [
      'runtime owner',
      [{ id: 'repo-1', executionHostId: 'runtime:owner' }],
      'focused',
      'owner:repo-1'
    ],
    ['local owner', [{ id: 'repo-1', executionHostId: 'local' }], 'focused', 'local:repo-1'],
    ['unstamped row follows focus', [{ id: 'repo-1' }], 'focused', 'focused:repo-1'],
    ['missing row follows focus', [], 'focused', 'focused:repo-1'],
    ['missing row, local focus', [], null, 'local:repo-1'],
    [
      'duplicates fall back to focus',
      [
        { id: 'repo-1', executionHostId: 'local' },
        { id: 'repo-1', executionHostId: 'runtime:owner' }
      ],
      'other',
      'other:repo-1'
    ]
  ])('%s', (_name, repos, focused, expected) => {
    expect(cacheKeyFor(repos, focused)).toBe(expected)
  })
})
