import { it, expect, vi, afterEach } from 'vitest'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../slices/store-test-helpers'
import { TEST_REPO } from '../slices/worktrees-slice-test-fixtures'
import {
  type RuntimeEnvironmentCallRequest,
  createCompatibleRuntimeStatusResponseIfNeeded
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import * as drafts from '@/components/native-chat/native-chat-composer-draft-store'

afterEach(() => vi.restoreAllMocks())

it.each(['single', 'all-host', 'runtime'] as const)(
  'accepted %s catalog applies pending subsets/new repositories and same-batch chains through its real caller',
  async (caller) => {
    drafts.clearNativeChatComposerDraftsForTests()
    clearRuntimeCompatibilityCacheForTests()
    const store = createTestStore()
    const oldRepo = {
      ...TEST_REPO,
      id: 'repo-a',
      executionHostId: 'ssh:old' as const,
      connectionId: 'old'
    }
    const otherRepo = { ...oldRepo, id: 'repo-b' }
    const from = drafts.nativeChatLaunchPromptDraftScopeKey('repo-a::/x', 'codex', 'ssh:old')
    const second = drafts.nativeChatLaunchPromptDraftScopeKey('repo-b::/y', 'claude', 'ssh:old')
    drafts.updateNativeChatComposerDraft(from, { text: 'first task' }, 'immediate')
    drafts.updateNativeChatComposerDraft(second, { text: 'second task' }, 'immediate')
    store.setState({ repos: [oldRepo, otherRepo] })
    store
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo-a'] }])
    // A merged accepted descriptor adds a new repo instead of treating its inherited claims as complete.
    store
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo-b'] }])
    expect(
      drafts.readNativeChatComposerDraft(
        drafts.nativeChatLaunchPromptDraftScopeKey('repo-b::/y', 'claude', 'ssh:new')
      ).text
    ).toBe('second task')
    store.setState({
      pendingSshRepoReadoptions: [
        { oldTargetId: 'new', newTargetId: 'third', repoIds: ['repo-a', 'repo-b'] },
        { oldTargetId: 'third', newTargetId: 'fourth', repoIds: ['repo-a', 'repo-b'] }
      ]
    })
    const nextRepos = [oldRepo, otherRepo].map((repo) => ({
      ...repo,
      executionHostId: 'ssh:fourth' as const,
      connectionId: 'fourth'
    }))
    const runtimeCall = vi.fn(
      async (args: RuntimeEnvironmentCallRequest) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: args.method,
          ok: true,
          result:
            args.method === 'settings.get'
              ? { settings: {} }
              : args.method === 'repo.list'
                ? { repos: [] }
                : { projects: [], setups: [] },
          _meta: { runtimeId: 'fixture' }
        }
    )
    vi.stubGlobal('window', {
      api: {
        repos: { list: vi.fn().mockResolvedValue(nextRepos) },
        projects: {
          list: vi.fn().mockResolvedValue([]),
          listHostSetups: vi.fn().mockResolvedValue([])
        },
        runtimeEnvironments: { call: runtimeCall }
      }
    })
    if (caller === 'single') {
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    } else if (caller === 'all-host') {
      await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    } else {
      await store.getState().fetchRuntimeEnvironmentRepos('fixture-env')
    }
    expect(
      drafts.readNativeChatComposerDraft(
        drafts.nativeChatLaunchPromptDraftScopeKey('repo-a::/x', 'codex', 'ssh:fourth')
      ).text
    ).toBe('first task')
    expect(
      drafts.readNativeChatComposerDraft(
        drafts.nativeChatLaunchPromptDraftScopeKey('repo-b::/y', 'claude', 'ssh:fourth')
      ).text
    ).toBe('second task')
    expect(drafts.readNativeChatComposerDraft(from).text).toBe('first task')
    const occupant = drafts.nativeChatLaunchPromptDraftScopeKey('repo-a::/x', 'codex', 'ssh:third')
    drafts.updateNativeChatComposerDraft(
      occupant,
      { text: 'new intermediate occupant' },
      'immediate'
    )
    store
      .getState()
      .recordSshRepoReadoptions([
        { oldTargetId: 'third', newTargetId: 'fourth', repoIds: ['repo-a'] }
      ])
    expect(drafts.readNativeChatComposerDraft(occupant).text).toBe('new intermediate occupant')
    vi.unstubAllGlobals()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)
