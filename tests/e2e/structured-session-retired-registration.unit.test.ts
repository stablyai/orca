import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  root,
  B,
  openAuthorityRuntime,
  reveal,
  inWorkspace,
  physicalReload
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { acquireWatcherRemovalGate } from '../../src/main/ipc/watcher-removal-gate'
import { chatTabCommandsSettled } from '../../src/main/runtime/session-layout-apply.test-fixture'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import * as worktreePaths from '../../src/main/git/worktree-path-comparison'
import { randomUUID } from 'node:crypto'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../src/shared/agent-session/journal/agent-session-journal-types'
import { openAgentSessionJournal } from '../../src/main/native-chat/agent-session-journal/journal-store-factory'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import { withChatTabChanges } from '../../src/main/runtime/agent-session/agent-session-tab-layout'
import { getRepoMainWorktreeId } from '../../src/shared/worktree/id'
import { hostTestMessage } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { computeAgentSessionPayloadFingerprint } from '../../src/shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { agentSessionMessagePayload } from '../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionSubscribeEvent } from '../../src/shared/agent-session/agent-session-wire'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

async function retiredChat(instance = false) {
  const old = `retired-project::${root}${instance ? '::workspace:11111111-1111-4111-8111-111111111111' : ''}`
  const input = await inWorkspace(old, 'folder')
  input.profile.removeFolderWorkspace(input.folderId)
  input.profile.setWorkspaceSession(
    withChatTabChanges('local', getDefaultWorkspaceSession(), old, [
      { open: { sessionId: B, agent: 'codex', tabId: `agent-session:${B}` } }
    ])!
  )
  const rig = await openAuthorityRuntime(input)
  const record = rig.store.getRecord(B)!
  await rig.store.setConversationName(B, 'Retained project conversation')
  const journal = await openAgentSessionJournal({
    database: rig.host.deps.journalDatabase,
    identity: {
      sessionId: B,
      workspaceId: old,
      hostId: 'local',
      agent: record.provider,
      providerHandle: record.providerHandleChain.at(-1)?.handle ?? null
    }
  })
  await journal.appendItem(
    { provider: 'codex', threadId: 'retained-provider', turnId: 'retained-reply', ordinal: 0 },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'retained reply' }] },
    { fence: record.lease.runtimeFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.queuedMessages.insert({
    messageId: 'waiting-personal-message',
    body: hostTestMessage('keep my queued text')
  })
  const cursor = journal.cursor()
  await journal.close()
  return { ...rig, old, cursor, record }
}

it.each([false, true])(
  'reopens the same retained chat at the replacement folder root, old instance=%s',
  async (instance) => {
    const rig = await retiredChat(instance)
    // A previous build could cache this conversation before discovering its registration was gone.
    await rig.host.revealSession(B)
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: false } })
    const events: AgentSessionSubscribeEvent[] = []
    await rig.host.subscribe({
      id: 'existing-phone-reader',
      sessionId: B,
      emit: (event) => events.push(event)
    })
    const repo = storeRepo({ id: 'current-project', path: root, kind: 'folder' })
    rig.profile.addRepo(repo)
    const destination = getRepoMainWorktreeId(repo)
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: true, sessionId: B, workspaceId: destination }
    })
    await chatTabCommandsSettled()
    expect(rig.store.getRecord(B)).toMatchObject({
      location: { workspaceId: destination },
      conversationName: 'Retained project conversation',
      providerHandleChain: rig.record.providerHandleChain,
      accountHome: rig.record.accountHome
    })
    expect(
      rig.profile.getWorkspaceSession('local')?.unifiedTabs?.[rig.old] ?? []
    ).not.toContainEqual(expect.objectContaining({ entityId: B }))
    expect(rig.profile.getWorkspaceSession('local')?.unifiedTabs?.[destination]).toContainEqual(
      expect.objectContaining({ entityId: B })
    )
    const snapshot = await rig.host.journalSnapshot(B)
    expect(snapshot.cursor.epoch).toBe(rig.cursor.epoch)
    expect(JSON.stringify(snapshot)).toContain('retained reply')
    expect(JSON.stringify(events)).toContain('keep my queued text')
    const beforeContinuation = events.length
    const body = hostTestMessage('continue in the registered folder')
    const sent = await rig.host.send(
      { callerKey: 'retired-project-test' },
      {
        envelope: {
          sessionId: B,
          clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
          expectedRuntimeFence: rig.record.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: B,
            fields: { body: agentSessionMessagePayload(body) }
          })
        },
        body,
        userSend: true
      }
    )
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
    await Promise.resolve()
    expect(JSON.stringify(events.slice(beforeContinuation))).toContain(
      'continue in the registered folder'
    )
    expect(rig.host.listSessionTabs().find((tab) => tab.sessionId === B)).toMatchObject({
      workspaceId: destination
    })
  }
)

it.each([
  {
    conversationCommand: {
      command: 'compact' as const,
      phase: 'prepared' as const,
      state: 'unknown' as const,
      operationId: 'old-compact',
      callerKey: 'old-window'
    }
  },
  {
    conversationCommand: {
      command: 'compact' as const,
      phase: 'committed' as const,
      state: 'unknown' as const,
      operationId: 'old-compact',
      callerKey: 'old-window'
    }
  },
  {
    rewind: {
      operationId: 'old-rewind',
      callerKey: 'old-window',
      itemId: 'codex:retained-provider:retained-reply:0',
      expectedEpoch: 'epoch-before-rewind',
      phase: 'provider-succeeded' as const
    }
  },
  {
    rewind: {
      operationId: 'old-rewind',
      callerKey: 'old-window',
      itemId: 'codex:retained-provider:retained-reply:0',
      expectedEpoch: 'epoch-before-rewind',
      phase: 'prepared' as const
    }
  }
])('saved in-doubt work from an earlier process does not block recovery: %j', async (saved) => {
  const rig = await retiredChat()
  await rig.store.transitionHandoff(B, (record) => ({ ...record, ...saved }))
  const repo = storeRepo({ id: 'current-project', path: root, kind: 'folder' })
  rig.profile.addRepo(repo)
  const destination = getRepoMainWorktreeId(repo)
  const opened = { ok: true, result: { ok: true, sessionId: B, workspaceId: destination } }
  expect(await reveal(rig)).toMatchObject(opened)
  expect(await reveal(rig)).toMatchObject(opened)
  const fresh = await physicalReload(rig)
  expect(await reveal(fresh)).toMatchObject(opened)
  const record = fresh.store.getRecord(B)
  expect(record?.location.workspaceId).toBe(destination)
  if ('conversationCommand' in saved) {
    // A legacy result stays recorded so its operation still replays it.
    expect(record?.conversationCommand).toEqual(saved.conversationCommand)
  } else {
    // Only a provider-confirmed rewind settles without the provider; a prepared one stays in doubt.
    expect(record?.rewind?.phase).toBe(
      saved.rewind.phase === 'provider-succeeded' ? 'completed' : 'prepared'
    )
  }
})

it('recovers a retired repo registration into a current scoped folder without reviving deleted scoped folders', async () => {
  const input = await inWorkspace(`retired-project::${root}`, 'folder')
  const rig = await openAuthorityRuntime(input)
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: `folder:${input.folderId}` }
  })
  expect(rig.store.getRecord(B)?.location.workspaceKind).toBe('folder')
  await rig.runtime.deleteFolderWorkspace(input.folderId)
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_workspace_removed' } }
  })
})

it('keeps both saved addresses unchanged when destination removal overtakes the queued rebind', async () => {
  const rig = await retiredChat()
  rig.profile.addRepo(storeRepo({ id: 'current-project', path: root, kind: 'folder' }))
  const rebind = rig.store.rebindWorkspace.bind(rig.store)
  let removal: ReturnType<typeof acquireWatcherRemovalGate> | undefined
  vi.spyOn(rig.store, 'rebindWorkspace').mockImplementationOnce(async (...args) => {
    removal = acquireWatcherRemovalGate(root)
    removal.abandonPendingInstalls()
    return rebind(...args)
  })
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
  })
  const gate = await removal
  gate?.release()
  expect(rig.store.getRecord(B)?.location.workspaceId).toBe(rig.old)
  expect(
    rig.host.deps.journalDatabase.db
      .prepare('SELECT workspace_id FROM journal_sessions WHERE session_id = ?')
      .get(B)
  ).toMatchObject({ workspace_id: rig.old })
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
})

it('never guesses between same-directory registrations or crosses execution hosts', async () => {
  const rig = await retiredChat()
  rig.profile.addRepo(
    storeRepo({ id: 'foreign-project', path: root, kind: 'folder', executionHostId: 'ssh:offline' })
  )
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: false } })
  rig.profile.addRepo(storeRepo({ id: 'current-one', path: root, kind: 'folder' }))
  rig.profile.addRepo(storeRepo({ id: 'current-two', path: root, kind: 'folder' }))
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: false } })
  expect(rig.store.getRecord(B)?.location.workspaceId).toBe(rig.old)
  expect(rig.acquire).not.toHaveBeenCalled()
})

it('bounds explicit recovery to cached catalog work and one destination authority', async () => {
  const rig = await retiredChat()
  const destination = storeRepo({ id: 'current-project', path: root, kind: 'folder' })
  rig.profile.addRepo(destination)
  const comparisons = vi.spyOn(worktreePaths, 'areWorktreePathsEqual')
  const counts: number[] = []
  let added = 0
  for (const population of [20, 200]) {
    while (added < population) {
      rig.profile.addRepo(
        storeRepo({ id: `unrelated-${added}`, path: `${root}/other-${added}`, kind: 'folder' })
      )
      added++
    }
    comparisons.mockClear()
    const authority = await rig.runtime.prepareStructuredAgentSessionRevealWorkspace(
      rig.record.location
    )
    expect(authority.location.workspaceId).toBe(getRepoMainWorktreeId(destination))
    authority.release()
    counts.push(comparisons.mock.calls.length)
  }
  expect(counts[1]).toBeLessThanOrEqual(10 * counts[0] + 30)
})
