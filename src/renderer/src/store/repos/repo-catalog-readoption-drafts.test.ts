import { it, expect, vi, afterEach } from 'vitest'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'
import { TEST_REPO } from './repo.test-fixture'
import {
  type RuntimeEnvironmentCallRequest,
  createCompatibleRuntimeStatusResponseIfNeeded
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import * as drafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as draftsOwner1 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as draftsOwner2 from '@/components/native-chat/drafts/native-chat-composer-draft-store'

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
    const from = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo-a::/x', 'codex', 'ssh:old')
    const second = draftsOwner1.nativeChatLaunchPromptDraftScopeKey(
      'repo-b::/y',
      'claude',
      'ssh:old'
    )
    draftsOwner2.updateNativeChatComposerDraft(from, { text: 'first task' }, 'immediate')
    draftsOwner2.updateNativeChatComposerDraft(second, { text: 'second task' }, 'immediate')
    store.setState({ repos: [oldRepo, otherRepo] })
    store
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo-a'] }])
    // A merged accepted descriptor adds a new repo instead of treating its inherited claims as complete.
    store
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo-b'] }])
    expect(
      draftsOwner2.readNativeChatComposerDraft(
        draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo-b::/y', 'claude', 'ssh:new')
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
      draftsOwner2.readNativeChatComposerDraft(
        draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo-a::/x', 'codex', 'ssh:fourth')
      ).text
    ).toBe('first task')
    expect(
      draftsOwner2.readNativeChatComposerDraft(
        draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo-b::/y', 'claude', 'ssh:fourth')
      ).text
    ).toBe('second task')
    expect(draftsOwner2.readNativeChatComposerDraft(from).text).toBe('first task')
    const occupant = draftsOwner1.nativeChatLaunchPromptDraftScopeKey(
      'repo-a::/x',
      'codex',
      'ssh:third'
    )
    draftsOwner2.updateNativeChatComposerDraft(
      occupant,
      { text: 'new intermediate occupant' },
      'immediate'
    )
    store
      .getState()
      .recordSshRepoReadoptions([
        { oldTargetId: 'third', newTargetId: 'fourth', repoIds: ['repo-a'] }
      ])
    expect(draftsOwner2.readNativeChatComposerDraft(occupant).text).toBe(
      'new intermediate occupant'
    )
    vi.unstubAllGlobals()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)
