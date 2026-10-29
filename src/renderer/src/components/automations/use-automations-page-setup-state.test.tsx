// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { useAutomationsPageSetupState } from './use-automations-page-setup-state'

const checkRuntimeHooksMock = vi.hoisted(() =>
  vi.fn<
    (hostId: string, repoId: string, options?: { background?: boolean }) => Promise<HookCheckResult>
  >()
)
vi.mock('@/runtime/runtime-hooks-client', () => ({ checkRuntimeHooks: checkRuntimeHooksMock }))

type HookInput = Parameters<typeof useAutomationsPageSetupState>[0]

function renderSetupState(repos: Partial<Repo>[], focused: string | null, repoId = 'repo-1') {
  return renderHook(() =>
    useAutomationsPageSetupState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cache key reads only repos and settings.
      store: {
        repos,
        settings: { activeRuntimeEnvironmentId: focused },
        projectHostSetups: [],
        worktreesByRepo: {}
      } as unknown as HookInput['store'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the cache key and hook loader read.
      local: {
        draft: { projectId: repoId },
        automationHostTargetKey: null,
        selectedAutomationRuns: { rowKey: null, ownerKey: null, notice: null },
        selectedAutomationRunPageId: null,
        automationYamlHooksByRepoKey: {},
        automationHookCheckPromisesRef: { current: new Map() },
        setAutomationYamlHooksByRepoKey: () => {}
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
}

function cacheKeyFor(repos: Partial<Repo>[], focused: string | null, repoId = 'repo-1'): string {
  return renderSetupState(repos, focused, repoId).result.current.getAutomationHooksCacheKey(repoId)
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
    ['unstamped row stays local', [{ id: 'repo-1' }], 'focused', 'local:repo-1'],
    ['missing row follows focus', [], 'focused', 'focused:repo-1'],
    ['missing row, local focus', [], null, 'local:repo-1'],
    [
      'duplicates name no server, focus or not',
      [
        { id: 'repo-1', executionHostId: 'local' },
        { id: 'repo-1', executionHostId: 'runtime:owner' }
      ],
      'other',
      'local:repo-1'
    ]
  ])('%s', (_name, repos, focused, expected) => {
    expect(cacheKeyFor(repos, focused)).toBe(expected)
  })
})

// G6: the create dialog's preview must not boot a stopped WSL distro, but a save still reads orca.yaml.
describe('automation orca.yaml loading', () => {
  it('previews in the background and lets a save inspect in the foreground', async () => {
    const hooks = { scripts: { setup: 'pnpm i' } }
    let releasePreview!: (result: HookCheckResult) => void
    checkRuntimeHooksMock
      .mockReset()
      .mockReturnValueOnce(new Promise((resolve) => (releasePreview = resolve)))
      .mockResolvedValueOnce({ hasHooks: true, hooks, mayNeedUpdate: false })
    const { result } = renderSetupState([{ id: 'repo-1', executionHostId: 'local' }], null)

    let preview!: Promise<unknown>
    let save!: Promise<unknown>
    await act(async () => {
      preview = result.current.loadAutomationYamlHooksForRepo('repo-1', undefined, {
        background: true
      })
      save = result.current.loadAutomationYamlHooksForRepo('repo-1')
      releasePreview({
        status: 'error',
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false,
        unavailable: 'wsl-distro-stopped'
      })
      await expect(preview).resolves.toBeNull()
      await expect(save).resolves.toEqual(hooks)
    })
    expect(checkRuntimeHooksMock.mock.calls).toEqual([
      ['local', 'repo-1', { background: true }],
      ['local', 'repo-1', {}]
    ])
  })
})
