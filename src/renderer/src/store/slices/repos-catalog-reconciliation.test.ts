import { afterEach, describe } from 'vitest'

afterEach(() => vi.restoreAllMocks())
import { registerReposCatalogMergeIdentityTests } from './repos-catalog-merge-identity.spec'
import { registerReposRefreshIdentityTests } from './repos-refresh-identity.spec'
import { registerReposCatalogNotificationsTests } from './repos-catalog-notifications.spec'
import { registerReposStaleFetchTests } from './repos-stale-fetch.spec'
import { registerReposSharedProjectBadgeColorTests } from './repos-shared-project-badge-color.spec'
import { registerReposAllHostsFolderWorkspacesTests } from './repos-all-hosts-folder-workspaces.spec'
import { registerReposRuntimeVisibilityDefaultsTests } from './repos-runtime-visibility-defaults.spec'

describe('repos-catalog-merge-identity', registerReposCatalogMergeIdentityTests)
describe('repos-refresh-identity', registerReposRefreshIdentityTests)
describe('repos-catalog-notifications', registerReposCatalogNotificationsTests)
describe('repos-stale-fetch', registerReposStaleFetchTests)
describe('repos-shared-project-badge-color', registerReposSharedProjectBadgeColorTests)
describe('repos-all-hosts-folder-workspaces', registerReposAllHostsFolderWorkspacesTests)
describe('repos-runtime-visibility-defaults', registerReposRuntimeVisibilityDefaultsTests)

import { expect, it, vi } from 'vitest'
import { createTestStore, TEST_REPO } from './store-test-helpers'
import * as drafts from '@/components/native-chat/native-chat-composer-draft-store'
import * as memory from '@/components/native-chat/native-chat-composer-draft-memory'
import * as sources from '@/components/native-chat/native-chat-launch-draft-source'
import * as pending from '@/components/native-chat/native-chat-pending-attachment-cache'
import { promptSkillRefs } from '@/components/native-chat/native-chat-prompt-document'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { reassignSshTargetId } from '../../../../main/persistence/leasing-ssh-ptys/ssh-target-reassignment'

it.each([10, 100])(
  'accepted collision/replay and committed new-writer revocation at %s owners',
  async (count) => {
    drafts.clearNativeChatComposerDraftsForTests()
    pending.clearNativeChatPendingAttachmentsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await drafts.hydrateNativeChatComposerDrafts()
    const store = createTestStore()
    const repo = {
      ...TEST_REPO,
      id: 'repo',
      executionHostId: 'ssh:old' as const,
      connectionId: 'old'
    }
    const nextRepo = { ...repo, executionHostId: 'ssh:new' as const, connectionId: 'new' }
    store.setState({ repos: [repo, nextRepo] })
    vi.stubGlobal('window', {
      api: {
        repos: { removeForHost: vi.fn().mockResolvedValue(undefined) },
        pty: { kill: vi.fn() }
      }
    })
    const rich = (path: string, id: string) => ({
      text: '$review',
      images: [
        { id: 'shared', path: '/shared.png' },
        { id, path: `${id}.png` }
      ],
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'nativeChatSkill', attrs: { token: '$review', path } }]
          }
        ]
      }
    })
    const control = drafts.nativeChatLaunchPromptDraftScopeKey('live::/x', 'claude', 'ssh:other')
    drafts.updateNativeChatComposerDraft(control, { text: 'keep' }, 'immediate')
    const untouched = vi.fn()
    const unsubControl = drafts.subscribeToNativeChatComposerDraft(control, untouched)
    const rows = Array.from({ length: count }, (_, i) => {
      const id = `repo::/w${i}`
      const from = drafts.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'ssh:old')
      const to = drafts.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'ssh:new')
      drafts.updateNativeChatComposerDraft(
        from,
        rich(`/from${i}/SKILL.md`, `from${i}`),
        'immediate'
      )
      drafts.updateNativeChatComposerDraft(to, rich(`/to${i}/SKILL.md`, `to${i}`), 'immediate')
      sources.writeLaunchSetupOptions(from, {
        agent: 'claude',
        surface: 'terminal',
        choices: { model: 'source' }
      })
      sources.writeLaunchSetupOptions(to, {
        agent: 'claude',
        surface: 'chat',
        choices: { model: 'target' }
      })
      const token = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      drafts.appendToNativeChatComposerDraft(from, { text: nativeChatPastedTextToken(token) })
      nativeChatPastedTextOperations.set(token, { scopeKey: from, text: 'held source bytes' })
      const attempt = drafts.captureNativeChatComposerSubmission(from)
      const targetAttempt = drafts.captureNativeChatComposerSubmission(to)
      const stop = vi.fn(memory.subscribeToNativeChatComposerDraftAppend(from, vi.fn()))
      attempt.stopObserving = stop
      if (i % 2) {
        drafts.updateNativeChatComposerDraft(
          from,
          { text: '', document: undefined, images: [] },
          'immediate'
        )
      }
      const changed = vi.fn()
      const targetChanged = vi.fn()
      const unsubscribe = drafts.subscribeToNativeChatComposerDraft(from, changed)
      const unsubTarget = drafts.subscribeToNativeChatComposerDraft(to, targetChanged)
      pending.addNativeChatPendingAttachment(to, { id: `target-${i}`, path: '', pending: true })
      pending.addNativeChatPendingAttachment(from, { id: `source-${i}`, path: '', pending: true })
      return {
        id,
        from,
        to,
        token,
        attempt,
        targetAttempt,
        stop,
        changed,
        targetChanged,
        unsubscribe,
        unsubTarget
      }
    })
    drafts.flushNativeChatComposerDrafts()
    await drafts.nativeChatComposerDraftWritesSettled()
    const work = {
      sources: 0,
      records: 0,
      listeners: 0,
      checks: 0,
      submissionReads: 0,
      submissionVisits: 0,
      observers: 0,
      pendingMoves: 0,
      chipWrites: 0,
      loading: 0,
      listenerMembers: 0,
      observerMembers: 0,
      attemptMembers: 0,
      tokenScans: 0,
      payloadWrites: 0,
      payloadCharacters: 0,
      removedStorageKeys: 0
    }
    const members = new WeakMap<
      Set<unknown>,
      'listenerMembers' | 'observerMembers' | 'attemptMembers'
    >()
    for (const set of memory.scopeListeners.values()) {
      members.set(set, 'listenerMembers')
    }
    for (const set of memory.appendListeners.values()) {
      members.set(set, 'observerMembers')
    }
    for (const set of memory.submissions.values()) {
      members.set(set, 'attemptMembers')
    }
    const setIterator = Set.prototype[Symbol.iterator]
    vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function* (this: Set<unknown>) {
      const name = members.get(this)
      for (const value of setIterator.call(this)) {
        if (name) {
          work[name]++
        }
        yield value
      }
    })
    const forEach = Set.prototype.forEach
    vi.spyOn(Set.prototype, 'forEach').mockImplementation(function (
      this: Set<unknown>,
      fn,
      thisArg
    ) {
      const name = members.get(this)
      if (name) {
        work[name] += this.size
      }
      return forEach.call(this, fn, thisArg)
    })
    const copied = (draft: unknown) => {
      if (draft) {
        work.payloadWrites++
        work.payloadCharacters += JSON.stringify(draft).length
      }
    }
    const update = storage.update
    vi.spyOn(storage, 'update').mockImplementation((scope, apply) =>
      update(scope, (stored) => {
        const next = apply(stored)
        copied(next)
        return next
      })
    )
    const write = storage.write
    vi.spyOn(storage, 'write').mockImplementation((scope, draft) => {
      copied(draft)
      return write(scope, draft)
    })
    const remove = storage.remove
    vi.spyOn(storage, 'remove').mockImplementation((scopes) => {
      work.removedStorageKeys += scopes.length
      return remove(scopes)
    })
    const tokenIterator = nativeChatPastedTextOperations[Symbol.iterator].bind(
      nativeChatPastedTextOperations
    )
    vi.spyOn(nativeChatPastedTextOperations, Symbol.iterator).mockImplementation(function* () {
      for (const entry of tokenIterator()) {
        work.tokenScans++
        yield entry
      }
    })
    const iterate = sources.launchDraftSources
    vi.spyOn(sources, 'launchDraftSources').mockImplementation(() => {
      const all = [...iterate()]
      work.sources += all.length
      return all
    })
    const countReads = <T>(
      family: Map<string, T>,
      key: 'records' | 'listeners' | 'checks' | 'submissionReads'
    ) => {
      const get = family.get.bind(family)
      vi.spyOn(family, 'get').mockImplementation((scope) => {
        work[key]++
        return get(scope)
      })
    }
    countReads(memory.records, 'records')
    countReads(memory.scopeListeners, 'listeners')
    countReads(memory.restoredImageChecks, 'checks')
    countReads(memory.submissions, 'submissionReads')
    const submissionIterator = memory.submissions[Symbol.iterator].bind(memory.submissions)
    vi.spyOn(memory.submissions, Symbol.iterator).mockImplementation(function* () {
      for (const entry of submissionIterator()) {
        work.submissionVisits += entry[1].size
        yield entry
      }
    })
    const move = pending.moveNativeChatPendingAttachments
    vi.spyOn(pending, 'moveNativeChatPendingAttachments').mockImplementation((from, to) => {
      work.pendingMoves++
      work.chipWrites +=
        pending.nativeChatPendingAttachmentSnapshot(from).length +
        pending.nativeChatPendingAttachmentSnapshot(to).length
      move(from, to)
    })
    const descriptor = { oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }
    store.getState().recordSshRepoReadoptions([descriptor])
    drafts.flushNativeChatComposerDrafts()
    await drafts.nativeChatComposerDraftWritesSettled()
    const transition = { ...work }
    expect(transition.sources).toBeLessThanOrEqual(4 * count + 4)
    expect(transition.pendingMoves).toBe(count)
    expect(transition.chipWrites).toBe(2 * count)
    expect(transition.loading).toBe(0)
    expect(transition.tokenScans).toBe(0)
    expect(transition.attemptMembers).toBe(2 * count)
    expect(transition.observerMembers).toBeLessThanOrEqual(3 * count)
    expect(transition.listenerMembers).toBeLessThanOrEqual(8 * count + 1)
    expect(transition.payloadWrites).toBe(0)
    expect(transition.payloadWrites).toBeLessThanOrEqual(3 * count)
    expect(transition.payloadCharacters).toBeLessThanOrEqual(1800 * count)
    expect(transition.removedStorageKeys).toBeLessThanOrEqual(2 * count)

    for (const key of ['records', 'listeners', 'checks', 'submissionReads'] as const) {
      expect(transition[key]).toBeLessThanOrEqual(40 * count + 10)
    }
    expect(untouched).not.toHaveBeenCalled()
    const before = rows.map((row, i) => {
      const held = drafts.readNativeChatComposerDraft(row.from)
      expect(promptSkillRefs(held.document)).toEqual(
        (i % 2 ? [`/to${i}/SKILL.md`] : [`/to${i}/SKILL.md`, `/from${i}/SKILL.md`]).map((path) => ({
          name: 'review',
          path
        }))
      )
      expect(sources.readLaunchSetupOptions(row.from)?.choices.model).toBe('target')
      expect(pending.nativeChatPendingAttachmentSnapshot(row.from).map((chip) => chip.id)).toEqual([
        `target-${i}`,
        `source-${i}`
      ])
      row.unsubscribe()
      row.changed.mockClear()
      row.targetChanged.mockClear()
      return held
    })
    const successor = drafts.nativeChatLaunchPromptDraftScopeKey(rows[0].id, 'claude', 'ssh:old')
    drafts.updateNativeChatComposerDraft(successor, { text: 'old address reused' }, 'immediate')
    store.getState().recordSshRepoReadoptions([{ ...descriptor }])
    rows.forEach((row, i) => {
      expect(drafts.readNativeChatComposerDraft(row.to)).toBe(before[i])
      expect(row.changed).not.toHaveBeenCalled()
    })
    expect(drafts.readNativeChatComposerDraft(successor).text).toBe('old address reused')
    const thirdRepo = { ...nextRepo, executionHostId: 'ssh:third' as const, connectionId: 'third' }
    store.setState({ repos: [nextRepo, thirdRepo] })
    store
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'new', newTargetId: 'third', repoIds: ['repo'] }])
    rows.forEach((row, i) => {
      if (i % 2 === 0) {
        expect(nativeChatPastedTextState(row.to, nativeChatPastedTextToken(row.token))).toBe(
          'saving'
        )
      }
      expect(settleNativeChatPastedText(row.token, `/saved-${i}.txt`)).toBe(i % 2 === 0)
    })
    expect(nativeChatPastedTextOperations.size).toBe(0)
    const beforeRemoval = { ...work }
    await store.getState().removeProject('repo', { hostId: 'ssh:third' })
    work.observers = rows.reduce((sum, row) => sum + row.stop.mock.calls.length, 0)
    expect(work.submissionVisits - beforeRemoval.submissionVisits).toBe(2 * count)
    expect(work.observers).toBe(count)
    expect(memory.submissions.size).toBe(0)
    // Source-only records/chips are deliberately subject to ordinary pre-call membership and stale-stamp limits.
    for (const row of rows) {
      expect(row.attempt.draft).toBeUndefined()
      expect(row.targetAttempt.draft).toBeUndefined()
      expect(drafts.readNativeChatComposerDraft(row.from)).toBeDefined()
      expect(pending.nativeChatPendingAttachmentSnapshot(row.from)).toHaveLength(2)
      row.unsubTarget()
    }
    const fresh = drafts.nativeChatLaunchPromptDraftScopeKey(rows[0].id, 'claude', 'ssh:third')
    drafts.updateNativeChatComposerDraft(fresh, rich('/fresh/SKILL.md', 'fresh'), 'immediate')
    const held = drafts.readNativeChatComposerDraft(fresh)
    rows.forEach((row) => drafts.finishNativeChatComposerSubmission(row.from, row.attempt, true))
    expect(drafts.readNativeChatComposerDraft(fresh)).toBe(held)
    expect(drafts.readNativeChatComposerDraft(control).text).toBe('keep')
    process.stdout.write(
      `${JSON.stringify({ metric: 'setup-association-and-committed-revocation', count, transition, removal: { attempts: work.submissionVisits - beforeRemoval.submissionVisits, observers: work.observers, remainingAttempts: memory.submissions.size } })}\n`
    )
    unsubControl()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    pending.clearNativeChatPendingAttachmentsForTests()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)

it('folder-only real main reassignment publishes origin-qualified UUID continuity without repo descriptors', async () => {
  drafts.clearNativeChatComposerDraftsForTests()
  const state = getDefaultPersistedState('/tmp/pr36659-memory-fixture')
  const folder = {
    id: 'uuid',
    projectGroupId: 'group',
    folderPath: '/folder',
    name: 'Folder',
    connectionId: 'old',
    executionHostId: 'ssh:old' as const,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  state.folderWorkspaces = [folder]
  const save = vi.fn()
  const from = drafts.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'ssh:old')
  const paired = drafts.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'runtime:other')
  drafts.updateNativeChatComposerDraft(from, { text: 'unsent folder' }, 'immediate')
  drafts.updateNativeChatComposerDraft(paired, { text: 'paired origin' }, 'immediate')
  expect(
    reassignSshTargetId(
      {
        state,
        protectedSecrets: { removeRetainedBlob: vi.fn() },
        scheduleSave: save,
        syncProjectHostSetupCompatibilityState: vi.fn()
      },
      'old',
      'new'
    )
  ).toEqual([])
  expect(save).toHaveBeenCalledOnce()
  const store = createTestStore()
  store.setState({ folderWorkspaces: [folder] })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        list: vi.fn().mockResolvedValue(state.folderWorkspaces),
        delete: vi.fn().mockResolvedValue(true)
      }
    }
  })
  await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
  const to = drafts.nativeChatLaunchPromptDraftScopeKey('folder:uuid', 'codex', 'ssh:new')
  expect(drafts.readNativeChatComposerDraft(to)).toBe(drafts.readNativeChatComposerDraft(from))
  expect(drafts.readNativeChatComposerDraft(to).text).toBe('unsent folder')
  // Operation origin/UUID still selects this source if its execution projection lags.
  store.setState({
    folderWorkspaces: [{ ...folder, connectionId: 'old', executionHostId: 'ssh:old' }]
  })
  expect(await store.getState().deleteFolderWorkspace('uuid', { executionHostId: 'ssh:old' })).toBe(
    true
  )
  expect(sources.launchDraftSource(from)?.executionHostId).toBe('ssh:new')
  expect(drafts.readNativeChatComposerDraft(paired).text).toBe('paired origin')
  vi.unstubAllGlobals()
  drafts.clearNativeChatComposerDraftsForTests()
})

import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'

it.each([10, 100])(
  'actual fetchAll adds zero setup observation or resource scans for %s unchanged repos',
  async (count) => {
    drafts.clearNativeChatComposerDraftsForTests()
    const store = createTestStore()
    const repos = Array.from({ length: count }, (_, i) => ({ ...TEST_REPO, id: `refresh-${i}` }))
    store.setState({ repos, hasHydratedWorktreePurge: true })
    for (const repo of repos) {
      const scope = drafts.nativeChatLaunchPromptDraftScopeKey(
        `${repo.id}::/source-only`,
        'codex',
        'local'
      )
      drafts.updateNativeChatComposerDraft(scope, { text: 'unchanged' }, 'immediate')
    }
    const listing = vi.fn(async (request: { repoId: string }) => ({
      repoId: request.repoId,
      authoritative: true,
      source: 'git',
      worktrees: []
    }))
    vi.stubGlobal('window', {
      api: { worktrees: { listDetected: listing }, pty: { kill: vi.fn() } }
    })
    const sourcesRead = vi.spyOn(sources, 'launchDraftSources')
    const resources = vi.spyOn(memory.submissions, Symbol.iterator)
    const recordsRead = vi.spyOn(memory.records, Symbol.iterator)
    await store.getState().fetchAllWorktrees()
    expect(listing).toHaveBeenCalledTimes(count)
    expect(sourcesRead).not.toHaveBeenCalled()
    expect(resources).not.toHaveBeenCalled()
    expect(recordsRead).not.toHaveBeenCalled()
    expect(memory.records.size).toBe(count)
    process.stdout.write(
      `${JSON.stringify({ metric: 'unchanged-fetchAll', count, listings: listing.mock.calls.length, setupObservations: sourcesRead.mock.calls.length, submissionScans: resources.mock.calls.length, recordScans: recordsRead.mock.calls.length })}\n`
    )
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)

import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from '@/components/native-chat/native-chat-pasted-text-reference'
import {
  settleNativeChatPastedText,
  nativeChatPastedTextState
} from '@/components/native-chat/native-chat-composer-pasted-text-references'

import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
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
