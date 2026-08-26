// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useComposerProviderRuntimeSync,
  type ComposerProviderRuntimeSyncInput
} from './provider-runtime-sync'

let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const gh = {
    repoSlug: vi.fn<Window['api']['gh']['repoSlug']>()
  } satisfies Pick<Window['api']['gh'], 'repoSlug'>
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('useComposerProviderRuntimeSync', () => {
  it('drops an older provider slug result after the selected repo/runtime context changes', async () => {
    const first = deferred<{ owner: string; repo: string }>()
    const second = deferred<{ owner: string; repo: string }>()
    vi.spyOn(window.api.gh, 'repoSlug')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const setSelectedRepoSlug = vi.fn<ComposerProviderRuntimeSyncInput['setSelectedRepoSlug']>()
    const common = {
      promptCaretFrameRef: { current: null },
      selectedRepoExecutionHostId: 'local',
      selectedRepoHookContextKey: 'local:repo',
      selectedRepoIsGit: true,
      selectedRepoSettings: null,
      selectedRepoSettingsRef: { current: null },
      setCheckedHooksContextKey:
        vi.fn<ComposerProviderRuntimeSyncInput['setCheckedHooksContextKey']>(),
      setSelectedRepoSlug,
      setSetupAgentStartupPolicy:
        vi.fn<ComposerProviderRuntimeSyncInput['setSetupAgentStartupPolicy']>(),
      setYamlHooks: vi.fn<ComposerProviderRuntimeSyncInput['setYamlHooks']>(),
      setupAgentStartupPolicyDraftRef: { current: null },
      setupAgentStartupPolicyRef: { current: 'start-immediately' },
      setupAgentStartupPolicySaveRef: { current: null },
      updateRepo: vi.fn<ComposerProviderRuntimeSyncInput['updateRepo']>()
    } satisfies Omit<
      ComposerProviderRuntimeSyncInput,
      'repoId' | 'selectedRepo' | 'selectedRepoPath'
    >
    const state = (repoId: string): ComposerProviderRuntimeSyncInput => ({
      ...common,
      repoId,
      selectedRepo: {
        id: repoId,
        path: `/repos/${repoId}`,
        displayName: repoId,
        badgeColor: '#000000',
        addedAt: 0
      },
      selectedRepoPath: `/repos/${repoId}`
    })
    const hook = renderHook(({ repoId }) => useComposerProviderRuntimeSync(state(repoId)), {
      initialProps: { repoId: 'first' }
    })

    hook.rerender({ repoId: 'second' })
    first.resolve({ owner: 'orca', repo: 'stale' })
    await act(async () => first.promise)
    expect(setSelectedRepoSlug).not.toHaveBeenCalledWith({ owner: 'orca', repo: 'stale' })

    second.resolve({ owner: 'orca', repo: 'current' })
    await act(async () => second.promise)
    expect(setSelectedRepoSlug).toHaveBeenLastCalledWith({ owner: 'orca', repo: 'current' })
  })
})
