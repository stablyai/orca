// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { useDerivedComposerState } from '@/hooks/composer-state/derived-composer-state'
import { useLinkedItemLookupEffects } from '@/hooks/composer-state/linked-item-lookup-effects'
import { useQuickSubmitPreparation } from '@/hooks/composer-state/quick-submit-preparation'
import { resolveFolderSetupSupported, useFolderSetupSupport } from './use-folder-setup-supported'

const { supportsCapability } = vi.hoisted(() => ({ supportsCapability: vi.fn() }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: supportsCapability
}))
vi.mock('@/hooks/useRetiredWorktreeNames', () => {
  const retiredNames = { names: [], exhaustedTiers: 0 }
  return { useRetiredWorktreeNames: () => retiredNames }
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function folderRepo(id: string): Repo {
  return {
    id,
    path: `/folders/${id}`,
    displayName: id,
    badgeColor: 'blue',
    addedAt: 0,
    kind: 'folder',
    executionHostId: `runtime:${id}`
  }
}

function deferred() {
  let resolve!: (supported: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const noop = () => {}
const hooks = { scripts: { setup: 'echo setup' } }
const emptyWorktrees = {}
const branchAutoNameRef = { current: '' }

function useSetupComposer(repo: Repo) {
  const [setupDecision, setSetupDecision] = useState<'run' | 'skip' | null>(null)
  const derived = useDerivedComposerState({
    agentPrompt: '',
    checkedHooksContextKey: repo.id,
    enableIssueAutomation: false,
    hasLoadedIssueCommand: false,
    issueCommandTemplate: '',
    linkDebouncedQuery: '',
    linkDirectItem: null,
    linkItems: [],
    linkedIssue: '',
    linkedPR: null,
    linkedWorkItem: null,
    name: 'chosen',
    repoId: repo.id,
    selectedRepo: repo,
    selectedRepoHookContextKey: repo.id,
    selectedRepoIsGit: false,
    selectedRepoSlug: null,
    setupDecision,
    sparseDirectories: '',
    sparseEnabled: false,
    sparsePresetsByRepo: {},
    sparseSelectedPresetId: null,
    worktreesByRepo: emptyWorktrees,
    yamlHooks: hooks
  })
  useLinkedItemLookupEffects({
    baseBranch: '',
    linkPopoverOpen: false,
    linkQuery: '',
    normalizedLinkQuery: derived.normalizedLinkQuery,
    prefetchWorkItems: async () => {},
    prefetchWorktreeCreateBase: async () => {},
    repoId: repo.id,
    selectedRepo: repo,
    selectedRepoConnectionId: null,
    selectedRepoGitHubSourceContext: null,
    selectedRepoIsGit: false,
    selectedRepoSshStatus: null,
    setLinkDebouncedQuery: noop,
    setLinkDirectItem: noop,
    setLinkDirectLoading: noop,
    setLinkItems: noop,
    setLinkItemsLoading: noop,
    setSetupDecision,
    setupConfig: derived.setupConfig,
    setupPolicy: derived.setupPolicy,
    shouldWaitForSetupCheck: derived.shouldWaitForSetupCheck,
    sshConnectedGeneration: 0
  })
  const { prepareQuickSubmit } = useQuickSubmitPreparation({
    branchAutoNameRef,
    branchIntent: 'create-new',
    branchNameOverridePreservesNameEdits: false,
    checkedHooksContextKey: repo.id,
    commitHookCheckIfCurrent: () => true,
    enableIssueAutomation: false,
    isSubmissionCancelled: () => false,
    loadHookCheckForRepo: async () => ({ hasHooks: true, hooks, mayNeedUpdate: false }),
    name: 'chosen',
    note: '',
    prepareQuickSubmitSource: () => ({
      submitLinkedWorkItem: null,
      agent: null,
      submitLinkedIssueNumber: null,
      submitLinkedPR: null,
      submitTitleName: null,
      nameIsAutoManaged: false,
      smartGitHubCreateNames: { workspaceName: 'chosen', displayName: undefined },
      workspaceName: 'chosen',
      nameWasGenerated: false,
      smartSubmitBaseBranch: undefined,
      submitCompareBaseRef: undefined,
      submitPushTarget: undefined,
      submitBranchNameOverride: undefined
    }),
    repoId: repo.id,
    resolvedSetupDecision: derived.resolvedSetupDecision,
    selectedRepo: repo,
    selectedRepoExecutionHostId: `runtime:${repo.id}`,
    selectedRepoHookContextKey: repo.id,
    selectedRepoIsGit: false,
    revealSetupChoice: noop,
    settings: null,
    setupConfig: derived.setupConfig,
    setupSupport: derived.setupSupport,
    setupDecision,
    setupPolicy: derived.setupPolicy,
    smartNameMode: 'text'
  })
  return { support: derived.setupSupport, setupDecision, setSetupDecision, prepareQuickSubmit }
}

it('preserves Skip across detached host replies and retires observations with their last reader', async () => {
  const requests = new Map<string, ReturnType<typeof deferred>[]>()
  supportsCapability.mockImplementation((id: string) => {
    const request = deferred()
    const history = requests.get(id) ?? []
    history.push(request)
    requests.set(id, history)
    return request.promise
  })
  function latest(id: string) {
    const request = requests.get(id)?.at(-1)
    if (!request) {
      throw new Error(`No capability request for ${id}`)
    }
    return request
  }

  const abandoned = Array.from({ length: 32 }, (_, index) => {
    const repo = folderRepo(`abandoned-${index}`)
    const consumer = renderHook(() => useFolderSetupSupport(repo))
    consumer.unmount()
    return latest(repo.id)
  })
  const repo = folderRepo('active')
  const composer = renderHook(() => useSetupComposer(repo))
  const peer = renderHook(() => useFolderSetupSupport(repo))
  await act(async () => latest(repo.id).resolve(true))
  expect(peer.result.current).toBe('supported')
  peer.unmount()
  act(() => composer.result.current.setSetupDecision('skip'))
  for (const request of abandoned) {
    await act(async () => request.resolve(true))
  }
  expect(composer.result.current.support).toBe('supported')
  expect(composer.result.current.setupDecision).toBe('skip')
  expect(requests.get(repo.id)).toHaveLength(1)

  await act(async () => {
    const submission = composer.result.current.prepareQuickSubmit({ kind: 'none' }, null, 'chosen')
    latest(repo.id).resolve(true)
    expect((await submission)?.effectiveSetupDecision).toBe('skip')
  })

  let activeRenders = 0
  const survivor = renderHook(() => {
    activeRenders += 1
    return useFolderSetupSupport(repo)
  })
  await act(async () => latest(repo.id).resolve(true))
  composer.unmount()
  const settledRenders = activeRenders
  for (const population of [200, 2000]) {
    for (let index = 0; index < population; index += 1) {
      const other = folderRepo(`churn-${population}-${index}`)
      const consumer = renderHook(() => useFolderSetupSupport(other))
      consumer.unmount()
      await act(async () => latest(other.id).resolve(true))
    }
    expect(survivor.result.current).toBe('supported')
    expect(activeRenders - settledRenders).toBe(0)
  }

  await act(async () => {
    const refresh = resolveFolderSetupSupported(repo)
    latest(repo.id).reject(new Error('offline'))
    await expect(refresh).rejects.toThrow('offline')
  })
  expect(survivor.result.current).toBe('supported')
  await act(async () => {
    const refresh = resolveFolderSetupSupported(repo)
    latest(repo.id).resolve(false)
    await refresh
  })
  expect(survivor.result.current).toBe('unsupported')

  const retired = resolveFolderSetupSupported(repo)
  const retiredRequest = latest(repo.id)
  survivor.unmount()
  const successor = renderHook(() => useFolderSetupSupport(repo))
  expect(successor.result.current).toBe('pending')
  await act(async () => {
    retiredRequest.resolve(true)
    await retired
  })
  expect(successor.result.current).toBe('pending')
  await act(async () => latest(repo.id).reject(new Error('offline')))
  expect(successor.result.current).toBe('pending')
  await act(async () => {
    const retry = resolveFolderSetupSupported(repo)
    latest(repo.id).resolve(true)
    await retry
  })
  expect(successor.result.current).toBe('supported')
  successor.unmount()
  supportsCapability.mockClear()
  const nextVisit = renderHook(() => useFolderSetupSupport(repo))
  const nextPeer = renderHook(() => useFolderSetupSupport(repo))
  const visitRequest = latest(repo.id)
  const joined = resolveFolderSetupSupported(repo)
  expect(supportsCapability).toHaveBeenCalledTimes(1)
  expect(nextVisit.result.current).toBe('pending')
  await act(async () => {
    visitRequest.resolve(false)
    await joined
  })
  expect(nextVisit.result.current).toBe('unsupported')
  expect(nextPeer.result.current).toBe('unsupported')
})
