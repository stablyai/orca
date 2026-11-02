import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/constants'
import { makeWorkspaceLineage } from '../../src/main/persistence/persistence-test-harness'
import * as folderTeardown from '../../src/main/runtime/folder-workspace-pty-teardown'
import * as pathPresence from '../../src/main/local-worktree-path-presence'
import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import * as worktreePaths from '../../src/main/git/worktree-path-comparison'
import * as gitRemoval from '../../src/main/git/worktree-removal'
import * as pushTargetCleanup from '../../src/main/ipc/worktree-remote'
import { finishRuntimeLocalWorktreeRemoval } from '../../src/main/runtime/runtime-registered-local-worktree-removal'
import { getRuntimeFolderWorkspaceInstanceId } from '../../src/main/runtime/runtime-folder-workspace'
import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../src/shared/agent-session/journal/agent-session-journal-types'
import { openAgentSessionJournal } from '../../src/main/native-chat/agent-session-journal/journal-store-factory'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from '../../src/main/runtime/rpc/methods/structured-agent-session-reveal'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/agent-session/agent-session-runtime-capabilities'
import {
  acquireWatcherRemovalGate,
  beginWatcherInstall
} from '../../src/main/ipc/watcher-removal-gate'
import { chatTabCommandsSettled } from '../../src/main/runtime/session-layout-apply.test-fixture'
import {
  root,
  B,
  authorityProfile,
  openAuthorityRuntime,
  savedIds,
  AuthorityRuntime
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { removalPtyProvider } from '../../src/main/runtime/rpc/worktree-rm-pty.test-fixture'
import type { DurableProfileStateMutation } from '../../src/main/persistence/loading-store/store-runtime-state'
import * as publication from '../../src/main/runtime/session-tabs/structured-session-tab-publication'
import {
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from '../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import { hostWorktreeTarget } from '../../src/shared/worktree/host-qualified-identity'
import type { RuntimeWorktreeScanResult } from '../../src/main/runtime/repo-worktree-resolution-scan'
import { openMobileAgentHistoryChat } from '../../mobile/src/agent-history/open-mobile-agent-history-chat'
import { hostRouteWithNotice } from '../../mobile/src/host-route-notice'
import type { RpcClient } from '../../mobile/src/transport/rpc-client'
import type { AiVaultSession } from '../../src/shared/ai-vault-types'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type Rig = Awaited<ReturnType<typeof openAuthorityRuntime>>
function phoneClient(rig: Rig): RpcClient {
  return {
    sendRequest: async (method) =>
      method === 'orchestration.partyLocation'
        ? {
            id: 'location',
            ok: true,
            result: { location: { kind: 'chat', sessionId: B, worktreeId: rig.workspace } }
          }
        : method === 'session.tabs.list'
          ? {
              id: 'tabs',
              ok: true,
              result: {
                tabs: rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)?.tabs ?? []
              }
            }
          : method === 'agentSession.reveal'
            ? reveal(rig)
            : Promise.reject(new Error('No activation or terminal fallback is expected')),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getGeneration: () => 1,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}
function historySession(): AiVaultSession {
  return {
    id: 'history',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: B,
    title: 'retained',
    cwd: root,
    branch: null,
    model: null,
    filePath: '',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex',
    subagent: null
  }
}

async function reveal(rig: Awaited<ReturnType<typeof openAuthorityRuntime>>, caller = true) {
  return new RpcDispatcher({
    runtime: rig.runtime,
    methods: STRUCTURED_AGENT_SESSION_REVEAL_METHODS
  }).dispatch(
    {
      id: 'retained-history',
      authToken: 'token',
      method: 'agentSession.reveal',
      params: { sessionId: B, ...(caller ? { navigation: 'caller' } : {}) }
    },
    {
      clientKind: 'mobile',
      pairedDeviceId: 'phone',
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
  )
}

it.each([true, false])(
  'refuses retained History after actual folder removal without publishing, caller=%s',
  async (caller) => {
    const profile = await authorityProfile()
    const lineage = makeWorkspaceLineage()
    profile.profile.setWorkspaceLineage(lineage)
    const layout = profile.profile.getWorkspaceSession('local')
    if (!layout) {
      throw new Error('the saved layout must exist')
    }
    profile.profile.setWorkspaceSession({
      ...layout,
      openFilesByWorktree: {
        'retained-drafts': [
          {
            filePath: `${root}/notes.txt`,
            relativePath: 'notes.txt',
            worktreeId: 'retained-drafts',
            language: 'text',
            dirtyDraftContent: 'unsent draft'
          }
        ]
      }
    })
    const { provider } = removalPtyProvider([])
    const rig = await openAuthorityRuntime(
      profile,
      new AuthorityRuntime(profile.profile, undefined, {
        getLocalProvider: () => provider
      })
    )
    const record = rig.store.getRecord(B)
    if (!record) {
      throw new Error('the retained conversation must exist')
    }
    const journal = await openAgentSessionJournal({
      database: rig.host.deps.journalDatabase,
      identity: {
        sessionId: B,
        workspaceId: rig.workspace,
        hostId: 'local',
        agent: record.provider,
        providerHandle: record.providerHandleChain.at(-1)?.handle ?? null
      }
    })
    try {
      await journal.appendItem(
        { provider: 'claude', sessionId: 'provider-session-alpha-1', uuid: 'retained-reply' },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'retained reply' }] },
        { fence: record.lease.runtimeFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    } finally {
      await journal.close()
    }
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const transcript = (await rig.host.journalSnapshot(B)).items
    expect(transcript).toHaveLength(1)
    expect(rig.runtime.live(B)).toBe(true)
    expect(await rig.runtime.deleteFolderWorkspace(rig.folderId)).toEqual({ deleted: true })
    const retained = rig.store.getRecord(B)
    const saved = structuredClone(rig.profile.getWorkspaceSession('local'))
    expect(saved?.openFilesByWorktree?.['retained-drafts']?.[0]?.dirtyDraftContent).toBe(
      'unsent draft'
    )
    expect(rig.profile.getAllWorkspaceLineage()).toEqual({ [lineage.childWorkspaceKey]: lineage })
    expect(retained).not.toBeNull()
    const result = await reveal(rig, caller)
    await chatTabCommandsSettled()
    expect(rig.store.getSessionTabId(B)).toBeNull()
    expect(rig.runtime.mobileSessionTabsByWorktree.has(rig.workspace)).toBe(false)
    expect(savedIds(rig)).toEqual([])
    expect(rig.store.getRecord(B)).toEqual(retained)
    expect(rig.profile.getWorkspaceSession('local')).toEqual(saved)
    expect(rig.profile.getAllWorkspaceLineage()).toEqual({ [lineage.childWorkspaceKey]: lineage })
    expect(rig.store.getRecord(B)?.providerHandleChain).toEqual(record.providerHandleChain)
    expect(rig.store.getRecord(B)?.location).toEqual(record.location)
    expect((await rig.host.journalSnapshot(B)).items).toEqual(transcript)
    expect(result).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_workspace_removed' } }
    })
    expect(rig.acquire).not.toHaveBeenCalled()
    const phone = phoneClient(rig)
    const opened = vi.fn(),
      failed = vi.fn()
    expect(
      await openMobileAgentHistoryChat({
        client: phone,
        session: {
          ...historySession(),
          structuredSession: { sessionId: B, workspaceId: rig.workspace }
        },
        hostId: 'owning-host',
        assertCurrentOwner: () => {},
        opened,
        failed
      })
    ).toBe(true)
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      hostRouteWithNotice('owning-host', 'worktree-missing')
    )
    expect(failed).not.toHaveBeenCalled()
    expect(rig.acquire).not.toHaveBeenCalled()
  }
)

it('opens valid V with an absent legacy index and unrelated unknown U without losing U', async () => {
  const profile = await authorityProfile([B, 'unknown-u'])
  const prior = await readPersistedTestAgentSessionStore(root)
  await seedTestAgentSessionRecordStore(root, {
    records: Object.values(prior.records).map((record) =>
      record.sessionId === 'unknown-u'
        ? {
            ...record,
            location: { ...record.location, workspaceId: 'offline-repo::/unreadable/unknown' }
          }
        : record
    )
  })
  const rig = await openAuthorityRuntime(profile)
  await rig.runtime.prepareStructuredAgentSessionStartupRestoration()
  const unknown = rig.store.getRecord('unknown-u')
  expect(rig.store.getVisibleSessionTabIndex().present).toBe(false)
  const result = await reveal(rig)
  await chatTabCommandsSettled()
  expect(result).toMatchObject({ ok: true, result: { ok: true, workspaceId: rig.workspace } })
  expect(rig.store.getVisibleSessionTabIndex()).toEqual({
    present: true,
    sessionIds: ['unknown-u', B]
  })
  expect(rig.store.getRecord('unknown-u')).toEqual(unknown)
  expect(savedIds(rig)).toEqual(['unknown-u', B])
  expect(
    rig.runtime.mobileSessionTabsByWorktree
      .get(rig.workspace)
      ?.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === B)
  ).toBe(true)
  expect(rig.acquire).not.toHaveBeenCalled()
})

it('reports uncertainty after actual SHOW and never projects raw after token abandonment', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([], { records: [B], visible: [] }))
  const admit = publication.admitStructuredSessionTabPublication
  vi.spyOn(publication, 'admitStructuredSessionTabPublication').mockImplementationOnce(
    async (...args) => {
      const result = await admit(...args)
      expect(rig.store.getSessionTabId(B)).toBe(result.tabId)
      const removal = acquireWatcherRemovalGate(root)
      removal.abandonPendingInstalls()
      await removal.ready
      removal.release()
      return result
    }
  )
  const reply = await reveal(rig)
  expect(reply).toMatchObject({ ok: false })
  expect(rig.store.getSessionTabId(B)).not.toBeNull()
  expect(rig.runtime.mobileSessionTabsByWorktree.has(rig.workspace)).toBe(false)
  expect(rig.store.getRecord(B)).not.toBeNull()
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
})

it.each(['fast', 'delayed'] as const)(
  'retains one token through %s real save and caller settlement',
  async (timing) => {
    const rig = await openAuthorityRuntime(
      await authorityProfile([], { records: [B], visible: [] })
    )
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let removal: ReturnType<typeof acquireWatcherRemovalGate> | undefined
    let drained = false
    const durable = rig.profile.runDurableMutation.bind(rig.profile)
    const publish = rig.runtime.publishStructuredAgentSessionTab.bind(rig.runtime)
    if (timing === 'delayed') {
      vi.spyOn(rig.profile, 'runDurableMutation').mockImplementationOnce(
        async <T>(mutate: () => DurableProfileStateMutation<T>): Promise<T> => {
          entered.resolve()
          await release.promise
          return durable(mutate)
        }
      )
    } else {
      vi.spyOn(rig.runtime, 'publishStructuredAgentSessionTab').mockImplementationOnce(
        async (input) => {
          await publish(input)
          await chatTabCommandsSettled()
          expect(savedIds(rig)).toEqual([B])
          removal = acquireWatcherRemovalGate(root)
          void removal.ready.then(() => {
            drained = true
          })
          await Promise.resolve()
          expect(drained).toBe(false)
        }
      )
    }
    try {
      expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
      if (timing === 'delayed') {
        await entered.promise
        removal = acquireWatcherRemovalGate(root)
        void removal.ready.then(() => {
          drained = true
        })
        await Promise.resolve()
        expect(drained).toBe(false)
        removal.abandonPendingInstalls()
        await removal.ready
        release.resolve()
        await chatTabCommandsSettled()
        expect(savedIds(rig)).toEqual([])
        // Expected false inner admission must leave the actual profile writer usable.
        await rig.profile.runDurableMutation(() => ({ value: undefined, persist: false }))
      } else {
        await removal?.ready
        expect(drained).toBe(true)
      }
    } finally {
      release.resolve()
      removal?.release()
    }
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
    await chatTabCommandsSettled()
    expect(savedIds(rig)).toEqual([B])
  }
)

class ScannedWorkspaceRuntime extends AuthorityRuntime {
  scans = 0
  scan: RuntimeWorktreeScanResult = { ok: false, worktrees: [] }
  protected override async listRepoWorktreesForResolution() {
    this.scans++
    return this.scan
  }
}

it.each([10, 100])(
  'bounds actual target reveal across %i repo roots and metadata aliases',
  async (n) => {
    const input = await authorityProfile([], { records: [B], visible: [] })
    for (let i = 0; i < n; i++) {
      input.profile.addRepo(storeRepo({ id: `owner-${i}`, path: `${root}/repo-${i}` }))
      input.profile.setWorktreeMeta(
        hostWorktreeTarget({ id: `owner-${i}::${root}/repo-${i}/topic`, hostId: 'local' }),
        {}
      )
    }
    const workspace = `owner-${n - 1}::${root}/repo-${n - 1}/topic`
    const prior = await readPersistedTestAgentSessionStore(root)
    await seedTestAgentSessionRecordStore(root, {
      records: Object.values(prior.records).map((record) => ({
        ...record,
        location: { ...record.location, workspaceId: workspace, workspaceKind: 'git-worktree' }
      })),
      sessionTabs: []
    })
    const runtime = new ScannedWorkspaceRuntime(input.profile)
    runtime.scan = {
      ok: true,
      worktrees: [
        {
          path: `${root}/repo-${n - 1}/topic`,
          head: 'abc1234',
          branch: 'topic',
          isBare: false,
          isMainWorktree: false
        }
      ]
    }
    const rig = await openAuthorityRuntime({ ...input, workspace }, runtime)
    await runtime.prepareStructuredAgentSessionStartupRestoration()
    let repoVisits = 0,
      metaVisits = 0
    const repos = input.profile.getRepos.bind(input.profile)
    const meta = input.profile.getAllWorktreeMetaForHost.bind(input.profile)
    vi.spyOn(input.profile, 'getRepos').mockImplementation(() => {
      const rows = repos()
      repoVisits += rows.length
      return rows
    })
    vi.spyOn(input.profile, 'getAllWorktreeMetaForHost').mockImplementation((hostId) => {
      const rows = meta(hostId)
      metaVisits += Object.keys(rows).length
      return rows
    })
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: true, workspaceId: workspace }
    })
    await chatTabCommandsSettled()
    expect(runtime.scans).toBe(1)
    expect(repoVisits).toBeGreaterThanOrEqual(n)
    expect(repoVisits).toBeLessThanOrEqual(40 * n)
    expect(metaVisits).toBe(n)
    expect(savedIds(rig)).toEqual([B])
  }
)

async function inWorkspace(
  workspace: string,
  kind: 'folder' | 'git-worktree' = 'git-worktree',
  executionHostId: 'local' | 'ssh:offline' = 'local'
) {
  const input = await authorityProfile([], { records: [B], visible: [] })
  const prior = await readPersistedTestAgentSessionStore(root)
  await seedTestAgentSessionRecordStore(root, {
    records: Object.values(prior.records).map((record) => ({
      ...record,
      location: { ...record.location, workspaceId: workspace, workspaceKind: kind, executionHostId }
    })),
    sessionTabs: []
  })
  return { ...input, workspace }
}

it.each([false, true])(
  'keeps failed-scan affirmative metadata behind actual Git finalization, accepted aliases=%s',
  async (aliases) => {
    const repo = storeRepo({ id: 'removal-owner', path: root })
    const path = aliases ? `/tmp/${basename(root)}/topic` : `${root}/topic`,
      registeredPath = aliases ? `/private${path}` : path,
      workspace = `${repo.id}::${path}`
    if (aliases) {
      expect(worktreePaths.areWorktreePathsEqual(path, registeredPath, 'darwin')).toBe(true)
      const canonical = worktreePaths.canonicalWorktreePath
      vi.spyOn(worktreePaths, 'canonicalWorktreePath').mockImplementation((value) =>
        canonical(value, 'darwin')
      )
    }
    const input = await inWorkspace(workspace)
    input.profile.addRepo(repo)
    input.profile.setWorktreeMeta(hostWorktreeTarget({ id: workspace, hostId: 'local' }), {})
    const runtime = new ScannedWorkspaceRuntime(input.profile)
    const rig = await openAuthorityRuntime(input, runtime)
    const record = structuredClone(rig.store.getRecord(B))
    const show = vi.spyOn(rig.host, 'setSessionTabVisibility')
    const raw = vi.spyOn(runtime, 'storeMobileSessionSnapshot')
    const gate = acquireWatcherRemovalGate(registeredPath)
    await gate.ready
    const events: string[] = []
    vi.spyOn(gitRemoval, 'removeWorktree').mockResolvedValue({})
    vi.spyOn(pushTargetCleanup, 'cleanupUnusedWorktreePushTargetRemote').mockImplementationOnce(
      async () => {
        events.push('cleanup')
        expect(input.profile.getWorktreeMetaForHost(workspace, 'local')).toBeDefined()
        expect.soft(await reveal(rig)).toMatchObject({ ok: false })
        await chatTabCommandsSettled()
        expect(rig.store.getSessionTabId(B)).toBeNull()
        expect(runtime.captureStructuredAgentSessionPresentation(B)).toEqual({
          raw: null,
          saved: []
        })
        expect(show).not.toHaveBeenCalled()
        expect(raw).not.toHaveBeenCalled()
      }
    )
    try {
      await finishRuntimeLocalWorktreeRemoval(
        {
          repo,
          target: { id: workspace },
          store: input.profile,
          removedPushTarget: undefined,
          localOptions: {},
          force: false,
          deleteBranch: false,
          closeWatchers: async () => {},
          preserveBranchHead: (result) => result ?? {},
          finishRemoval: () => {
            events.push('purge')
            expect
              .soft(() => {
                const finishInstall = beginWatcherInstall(path)
                finishInstall()
              })
              .toThrow()
            runtime.removeWorktreeMetadataAndHistory(input.profile, workspace, 'local')
          }
        },
        {
          path: registeredPath,
          branch: 'topic',
          head: 'abc1234',
          isBare: false,
          isMainWorktree: false
        },
        {
          finish: async (removed) => {
            expect(removed).toBe(true)
            events.push('release')
            gate.release()
          }
        }
      )
    } finally {
      gate.release()
    }
    expect(events).toEqual(['cleanup', 'purge', 'release'])
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
    })
    expect(runtime.mobileSessionTabsByWorktree.has(workspace)).toBe(false)
    await chatTabCommandsSettled()
    expect(runtime.captureStructuredAgentSessionPresentation(B)).toEqual({ raw: null, saved: [] })
    expect(savedIds(rig)).toEqual([])
    expect(rig.store.getRecord(B)).toEqual(record)
    input.profile.setWorktreeMeta(hostWorktreeTarget({ id: workspace, hostId: 'local' }), {})
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
    await chatTabCommandsSettled()
    expect(rig.store.getSessionTabId(B)).not.toBeNull()
    expect(runtime.captureStructuredAgentSessionPresentation(B).raw?.worktreeId).toBe(workspace)
    expect(savedIds(rig)).toEqual([B])
    expect(show).toHaveBeenCalledOnce()
    expect(raw).toHaveBeenCalledOnce()
    expect(rig.store.getRecord(B)?.providerHandleChain).toEqual(record?.providerHandleChain)
  }
)

it('fences actual folder-extra teardown through forget without denying its surviving root or fresh instance', async () => {
  const repo = storeRepo({ id: 'folder-owner', path: root, kind: 'folder' })
  const workspace = getRuntimeFolderWorkspaceInstanceId(repo, 'extra')
  const input = await inWorkspace(workspace)
  input.profile.addRepo(repo)
  const target = hostWorktreeTarget({ id: workspace, hostId: 'local' })
  input.profile.setWorktreeMeta(target, {})
  const { provider } = removalPtyProvider([])
  const rig = await openAuthorityRuntime(
    input,
    new AuthorityRuntime(input.profile, undefined, { getLocalProvider: () => provider })
  )
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
  await chatTabCommandsSettled()
  const cleanup = rig.runtime.removeWorktreeMetadataAndHistory.bind(rig.runtime)
  vi.spyOn(rig.runtime, 'removeWorktreeMetadataAndHistory').mockImplementation((...args) => {
    expect(() => beginWatcherInstall(root)).toThrow()
    cleanup(...args)
  })
  expect(await rig.runtime.removeManagedWorktree(`id:${workspace}`)).toEqual({})
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_workspace_removed' } }
  })
  expect(rig.store.getSessionTabId(B)).toBeNull()
  expect(rig.runtime.mobileSessionTabsByWorktree.has(workspace)).toBe(false)
  expect(savedIds(rig)).toEqual([])
  expect(rig.store.getRecord(B)).not.toBeNull()
  const rootAuthority = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace({
    executionHostId: 'local',
    wslDistro: null,
    workspaceKind: 'folder',
    workspaceId: `${repo.id}::${root}`
  })
  rootAuthority.release()
  input.profile.setWorktreeMeta(target, {})
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
})

it('refuses inside the actual queued SHOW transaction after its token is abandoned', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([], { records: [B], visible: [] }))
  const show = rig.store.setSessionTabVisibility.bind(rig.store)
  vi.spyOn(rig.store, 'setSessionTabVisibility').mockImplementationOnce(
    (id, visible, tabId, check, capture) =>
      show(
        id,
        visible,
        tabId,
        () => {
          const removal = acquireWatcherRemovalGate(root)
          removal.abandonPendingInstalls()
          removal.release()
          check?.()
        },
        capture
      )
  )
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
  })
  await chatTabCommandsSettled()
  expect(rig.store.getSessionTabId(B)).toBeNull()
  expect(rig.runtime.mobileSessionTabsByWorktree.has(rig.workspace)).toBe(false)
  expect(savedIds(rig)).toEqual([])
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
})

it.each([false, true])(
  'refuses at the actual raw store boundary, existing=%s',
  async (existing) => {
    const rig = await openAuthorityRuntime(
      await authorityProfile([], { records: [B], visible: [] })
    )
    if (existing) {
      expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
    }
    await chatTabCommandsSettled()
    const before = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)
    const project = publication.projectStructuredSessionTab
    vi.spyOn(publication, 'projectStructuredSessionTab').mockImplementationOnce((...args) => {
      const removal = acquireWatcherRemovalGate(root)
      removal.abandonPendingInstalls()
      removal.release()
      project(...args)
    })
    expect(await reveal(rig, false)).toMatchObject({ ok: false })
    await chatTabCommandsSettled()
    expect(rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)).toEqual(before)
    expect(rig.store.getSessionTabId(B)).not.toBeNull()
    expect(rig.store.getRecord(B)).not.toBeNull()
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
  }
)

it('successful owning Git scan plus positive repo/parent and absent saved W outranks old metadata', async () => {
  const repo = storeRepo({ id: 'git-owner', path: root })
  const workspace = `${repo.id}::${root}/checkouts/gone`
  const input = await inWorkspace(workspace)
  await mkdir(`${root}/checkouts`)
  input.profile.addRepo(repo)
  input.profile.setWorktreeMeta(hostWorktreeTarget({ id: workspace, hostId: 'local' }), {})
  const runtime = new ScannedWorkspaceRuntime(input.profile)
  runtime.scan = {
    ok: true,
    worktrees: [
      { path: root, head: 'abc1234', branch: 'main', isBare: false, isMainWorktree: true }
    ]
  }
  const rig = await openAuthorityRuntime(input, runtime)
  const record = rig.store.getRecord(B)
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_workspace_removed' } }
  })
  expect(rig.store.getSessionTabId(B)).toBeNull()
  expect(rig.runtime.mobileSessionTabsByWorktree.has(workspace)).toBe(false)
  expect(savedIds(rig)).toEqual([])
  expect(rig.store.getRecord(B)?.location).toEqual(record?.location)
  expect(input.profile.getWorktreeMetaForHost(workspace, 'local')).toBeDefined()
  await mkdir(`${root}/checkouts/gone`)
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
})

it('qualifies the full folder population without overriding existing ambiguous presentation refusal', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([], { records: [B], visible: [] }))
  await rig.runtime.prepareStructuredAgentSessionStartupRestoration()
  const folders = rig.profile.getFolderWorkspaces()
  const row = folders.find((folder) => folder.id === rig.folderId)
  if (!row) {
    throw new Error('real owning folder must exist')
  }
  const population = vi
    .spyOn(rig.profile, 'getFolderWorkspaces')
    .mockReturnValue([
      { ...row, executionHostId: 'ssh:offline', connectionId: 'offline' },
      ...folders
    ])
  const record = rig.store.getRecord(B)
  if (!record) {
    throw new Error('the retained folder record must exist')
  }
  const owner = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(record.location)
  try {
    expect(owner.current()).toBe(true)
  } finally {
    owner.release()
  }
  expect(await reveal(rig)).toMatchObject({
    ok: false,
    error: { message: 'Chat presentation scope is unavailable' }
  })
  await chatTabCommandsSettled()
  const before = rig.store.getSessionTabId(B)
  expect(before).not.toBeNull()
  population.mockReturnValue([...folders, { ...row, folderPath: `${root}/ambiguous` }])
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
  })
  expect(rig.store.getSessionTabId(B)).toBe(before)
  population.mockRestore()
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
})

it('preserves qualified SSH authority through failed scans without changing the local-only presentation contract', async () => {
  const repo = storeRepo({ id: 'ssh-owner', path: '/offline/repo', executionHostId: 'ssh:offline' })
  const workspace = `${repo.id}::/offline/topic`
  const input = await inWorkspace(workspace, 'git-worktree', 'ssh:offline')
  input.profile.addRepo(repo)
  input.profile.setWorktreeMeta(hostWorktreeTarget({ id: workspace, hostId: 'ssh:offline' }), {})
  const runtime = new ScannedWorkspaceRuntime(input.profile)
  const rig = await openAuthorityRuntime(input, runtime)
  await runtime.prepareStructuredAgentSessionStartupRestoration()
  const probe = vi.spyOn(pathPresence, 'localWorktreePathPresence')
  const record = rig.store.getRecord(B)
  if (!record) {
    throw new Error('the retained SSH record must exist')
  }
  const owner = await runtime.prepareStructuredAgentSessionRevealWorkspace(record.location)
  try {
    expect(owner.current()).toBe(true)
  } finally {
    owner.release()
  }
  expect(runtime.scans).toBe(1)
  expect(await reveal(rig)).toMatchObject({
    ok: false,
    error: { message: 'Chat presentation scope is unavailable' }
  })
  expect(probe).not.toHaveBeenCalled()
  expect(rig.store.getSessionTabId(B)).not.toBeNull()
})

it('excludes a late reveal after actual folder retirement while its authority row still awaits forget', async () => {
  const input = await authorityProfile()
  const { provider } = removalPtyProvider([])
  const rig = await openAuthorityRuntime(
    input,
    new AuthorityRuntime(input.profile, undefined, { getLocalProvider: () => provider })
  )
  await rig.runtime.restoreStructuredAgentSessionTabs()
  await chatTabCommandsSettled()
  const teardown = folderTeardown.teardownFolderWorkspacePtys
  vi.spyOn(folderTeardown, 'teardownFolderWorkspacePtys').mockImplementationOnce(
    async (...args) => {
      await teardown(...args)
      expect(rig.store.getSessionTabId(B)).toBeNull()
      expect(input.profile.getFolderWorkspaces().some((row) => row.id === rig.folderId)).toBe(true)
      expect(await reveal(rig)).toMatchObject({ ok: false })
      expect(rig.store.getSessionTabId(B)).toBeNull()
    }
  )
  expect(await rig.runtime.deleteFolderWorkspace(rig.folderId)).toEqual({ deleted: true })
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_workspace_removed' } }
  })
  expect(() => {
    const install = beginWatcherInstall(root)
    install()
  }).not.toThrow()
})

it('keeps the existing floating namespace reveal when its configured directory has disappeared', async () => {
  const input = await inWorkspace(FLOATING_TERMINAL_WORKTREE_ID, 'folder')
  input.profile.updateSettings({ floatingTerminalCwd: `${root}/removed-floating-directory` })
  const rig = await openAuthorityRuntime(input)
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
  })
  await chatTabCommandsSettled()
  expect(rig.store.getSessionTabId(B)).not.toBeNull()
  expect(savedIds(rig)).toEqual([B])
})
