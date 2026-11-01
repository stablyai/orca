import { createOrdinaryCrewCommandFixture } from './crew-recipient-public-command.test-fixture'
import { partialRuntimeStore } from '../../src/main/runtime/runtime-store-partial-fixture'
import { resolveOrcaSessionParty } from '../../src/main/runtime/orchestration/orchestration-party'
import { subscribeCrew } from '../../src/main/runtime/orchestration/crew/crew-stream'
import { CrewFrame, type OrchestrationCrewFrame } from '../../src/shared/orchestration-crew'
import { releaseAgentSessionRecordStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store-slot'
import { testOrcaSessionId } from '../../src/shared/orca-session-address-test-fixture'
import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  WORKER_PANE,
  sessionRecord
} from '../../src/main/runtime/rpc/orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../src/main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(async () => {
  const remaining = await releaseAgentSessionRecordStore()
  remaining?.journalDatabase.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function ordinaryCrewCommandFixture(actualIdentity = false, extraPanes: [string, string][] = []) {
  return createOrdinaryCrewCommandFixture(hostRef, actualIdentity, extraPanes)
}

it('keeps unique remembered Run authority after real target retirement and still refuses a retired terminal without an owner', async () => {
  const f = ordinaryCrewCommandFixture(true)
  let stop: (() => void) | undefined
  try {
    await f.command('term_worker', 'run-create', [['objective', 'live sender S']])
    const rs = f.db.getCurrentRunForPane(WORKER_PANE)
    await f.command('term_peer', 'run-create', [['objective', 'unique durable T owner']])
    const rt = f.db.getCurrentRunForPane(f.panes.get('term_peer')!)
    if (!rs || !rt) {
      throw new Error('ordinary Run producer missing')
    }
    await f.command('term_helper', 'run-use', [['id', rt.id]])
    expect(f.db.runsBoundToPane(f.panes.get('term_peer')!)).toEqual([])
    expect(f.db.getRunMailboxOwnerIdsForHandle('term_peer')).toEqual([rt.id])
    expect(f.db.getRunMailboxOwnerIdsForHandle('term_coord')).toEqual([])
    await f.send('term_peer', 'term_worker', 'unique history after move')
    await f.send('term_coord', 'term_worker', 'no-owner control before retirement')
    const frames: OrchestrationCrewFrame[] = []
    let current = f.runtime.getOrchestrationCrewSnapshot('term_worker')
    stop = subscribeCrew(
      () => {
        current = f.runtime.getOrchestrationCrewSnapshot('term_worker')
        return current
      },
      f.runtime.watchOrchestrationCrew,
      (value) => frames.push(CrewFrame.parse(value))
    )
    const initial = current.sections.talkingWith.find(
      (row) => row.openTarget?.kind === 'terminal' && row.openTarget.handle === 'term_peer'
    )
    const initialNoOwner = current.sections.talkingWith.find(
      (row) => row.openTarget?.kind === 'terminal' && row.openTarget.handle === 'term_coord'
    )
    expect(initial).toMatchObject({
      sendAddress: 'term_peer',
      latest: { direction: 'from', preview: 'hello' }
    })
    expect(initialNoOwner).toMatchObject({
      sendAddress: 'term_coord',
      latest: { direction: 'from', preview: 'hello' }
    })
    if (!initial || !initialNoOwner) {
      throw new Error('real traffic peer missing')
    }
    const peer = () => current.sections.talkingWith.find((row) => row.partyKey === initial.partyKey)
    const noOwner = () =>
      current.sections.talkingWith.find((row) => row.partyKey === initialNoOwner.partyKey)
    expect(f.runtime.handles.has('term_peer')).toBe(true)
    expect(f.runtime.handles.has('term_coord')).toBe(true)
    const completed = frames.filter((frame) => frame.type === 'complete').length
    const beforeRetirement = f.effects()
    f.runtime.onPtySpawned('pty_crew_term_peer', 'replacement', { awaitsRegistration: false })
    f.runtime.onPtySpawned('pty_crew_term_coord', 'replacement', { awaitsRegistration: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(frames.filter((frame) => frame.type === 'complete').length).toBeGreaterThan(completed)
    expect(f.effects()).toEqual(beforeRetirement)
    expect(f.runtime.handles.has('term_peer')).toBe(false)
    expect(f.runtime.handles.has('term_coord')).toBe(false)
    for (const handle of ['term_peer', 'term_coord']) {
      expect(f.runtime.getLiveTerminalPaneKey(handle)).toBeNull()
      expect(f.runtime.getTerminalWorktreeIdForHandle(handle)).toBeNull()
      expect(f.runtime.getTerminalProcessIncarnation(handle)).toBeNull()
    }
    expect(f.db.getRunMailboxOwnerIdsForHandle('term_peer')).toEqual([rt.id])
    expect(f.db.getRunMailboxOwnerIdsForHandle('term_coord')).toEqual([])
    expect(peer()).toMatchObject({
      partyKey: initial.partyKey,
      latest: initial.latest,
      sendAddress: 'term_peer'
    })
    expect(peer()).not.toHaveProperty('openTarget')
    expect(noOwner()).toMatchObject({
      partyKey: initialNoOwner.partyKey,
      latest: initialNoOwner.latest
    })
    expect(noOwner()).not.toHaveProperty('openTarget')
    expect(noOwner()).not.toHaveProperty('sendAddress')
    const beforeRefusal = f.effects()
    await expect(
      f.send('term_worker', 'term_coord', 'retired no-owner refused')
    ).rejects.toMatchObject({ code: 'terminal_not_found' })
    expect(f.effects()).toEqual(beforeRefusal)
    const published = peer()?.sendAddress
    if (!published) {
      throw new Error('unique durable public route missing after target retirement')
    }
    await f.send('term_worker', published, 'published retired unique owner')
    expect(f.mail().filter((row) => row.subject === 'published retired unique owner')).toEqual([
      expect.objectContaining({
        from_handle: 'term_worker',
        to_handle: `run:${rt.id}`,
        run_id: rt.id
      })
    ])
  } finally {
    stop?.()
    f.close()
  }
})

it('keeps a new ordinary terminal occupant distinct from its lost historical session identity at the real command boundary', async () => {
  const f = ordinaryCrewCommandFixture(true, [
    ['term_old', 'tab_old:ffffffff-ffff-4fff-8fff-ffffffffffff']
  ])
  try {
    const sessionId = testOrcaSessionId('chat-history')
    f.records.set(sessionId, sessionRecord(sessionId))
    const run = f.db.createRun({
      objective: 'hybrid historical identity',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: f.panes.get('term_coord')!
    })
    const task = f.db.createTask({ runId: run.id, spec: 'historical native process' })
    const historical = f.db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_old',
      processIncarnation: 'structured:chat-history',
      creator: { kind: 'system' },
      maxDepth: 10
    })
    f.db.completeDispatch(historical.id)
    f.db.db
      .prepare("UPDATE dispatch_contexts SET completed_at = '2000-01-01' WHERE id = ?")
      .run(historical.id)
    const currentProcess = f.runtime.getTerminalProcessIncarnation('term_old')
    expect(currentProcess).not.toBeNull()
    expect(currentProcess).not.toBe('structured:chat-history')
    expect(f.runtime.getLiveTerminalPaneKey('term_old')).toBe(f.panes.get('term_old'))
    f.db.insertMessage({
      from: 'term_old',
      to: 'term_peer',
      subject: 'Recent',
      body: 'retained alias'
    })
    const snapshot = f.runtime.getOrchestrationCrewSnapshot('term_peer')
    const row = snapshot.sections.talkingWith.find(
      (item) => item.latest?.preview === 'retained alias'
    )
    expect(row).toMatchObject({
      sendAddress: 'term_old',
      openTarget: { kind: 'terminal', handle: 'term_old' },
      latest: { direction: 'from', preview: 'retained alias' }
    })
    expect(JSON.parse(row!.partyKey)).toEqual([expect.any(String), 'term_old'])
    expect(() => resolveOrcaSessionParty(sessionId, f.db)).toThrow('worker identity')
    if (row?.sendAddress !== 'term_old') {
      throw new Error('ordinary public target missing')
    }
    await f.send('term_peer', row.sendAddress, 'published new ordinary occupant')
    expect(f.mail().filter((item) => item.subject === 'published new ordinary occupant')).toEqual([
      expect.objectContaining({ from_handle: 'term_peer', to_handle: 'term_old' })
    ])
    const before = f.effects()
    await expect(
      f.send('term_peer', `orca_session_id:${sessionId}`, 'lost historical identity refused')
    ).rejects.toMatchObject({ code: 'session_caller_not_live' })
    expect(f.effects()).toEqual(before)
  } finally {
    f.close()
  }
})

it.each([
  {
    name: 'keeps the genuine settled worker Dispatch preferred and sends its published address as a same-resource follow-up',
    from: 'term_coord',
    target: 'term_worker'
  },
  {
    name: 'sends the advertised settled helper Dispatch from its active delegated worker in place',
    from: 'term_worker',
    target: 'term_helper'
  }
])('$name', async ({ from, target }) => {
  const f = ordinaryCrewCommandFixture()
  try {
    const terminalCount = from === 'term_worker' ? 2 : 1
    if (from === 'term_worker') {
      Object.defineProperty(f.runtime, 'store', {
        value: partialRuntimeStore({ getSettings: () => ({ nestedWorkerMaxDepth: 3 }) })
      })
    }
    vi.mocked(f.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
      ['term_worker', target].includes(handle)
        ? {
            runtimeId: f.runtime.getRuntimeId(),
            terminalHandle: handle,
            ptyId: `pty_${handle}`,
            worktreeId: 'folder-worker-host',
            paneKey: f.panes.get(handle)!,
            processIncarnation: `process:${handle}`,
            launchTokenHash: null,
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )
    vi.spyOn(f.runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(f.runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder-worker-host',
      repoId: 'repo',
      displayName: 'worker',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      path: '/tmp',
      head: 'fixture',
      branch: 'fixture',
      isBare: false,
      isMainWorktree: true,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: '/tmp',
        head: 'fixture',
        branch: 'fixture',
        isBare: false,
        isMainWorktree: true
      }
    })
    vi.spyOn(f.runtime, 'showTerminal').mockImplementation(async (handle) => ({
      handle,
      worktreeId: 'folder-worker-host',
      worktreePath: '/tmp',
      branch: 'fixture',
      tabId: f.panes.get(handle)!.split(':')[0]!,
      leafId: f.panes.get(handle)!.split(':')[1]!,
      title: 'worker',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: 1,
      ptyId: `pty_${handle}`,
      rendererGraphEpoch: 1
    }))
    const create = vi.spyOn(f.runtime, 'createTerminal').mockResolvedValue({
      handle: target,
      worktreeId: 'folder-worker-host',
      title: 'worker'
    })
    vi.spyOn(f.runtime, 'waitForTerminal').mockResolvedValue({
      handle: target,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(f.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const prompt = vi.spyOn(f.runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: target,
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(f.runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(f.runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    await f.command('term_coord', 'run-create', [['objective', 'genuine worker follow-up']])
    if (from === 'term_worker') {
      create.mockResolvedValueOnce({
        handle: 'term_worker',
        worktreeId: 'folder-worker-host',
        title: 'worker'
      })
      await f.command('term_coord', 'worker-start', [
        ['spec', 'active delegated worker'],
        ['agent', 'codex'],
        ['worktree', 'id:folder-worker-host']
      ])
      expect(f.db.getCurrentRunForPane(WORKER_PANE)).toBeUndefined()
    }
    await f.command(from, 'worker-start', [
      ['spec', 'initial work'],
      ['agent', 'codex'],
      ['worktree', 'id:folder-worker-host']
    ])
    const started = z
      .object({ dispatchId: z.string(), taskId: z.string(), state: z.literal('ready') })
      .parse(f.receipts.findLast((entry) => entry.method === 'orchestration.workerStart')?.result)
    const resource = f.db.getWorkerTerminalResourceByOwner(started.dispatchId)
    expect(f.db.getWorkerDispatch(started.dispatchId)?.state).toBe('ready')
    expect(resource).toMatchObject({
      terminal_handle: target,
      process_incarnation: `process:${target}`,
      owner_dispatch_id: started.dispatchId
    })
    expect(create).toHaveBeenCalledTimes(terminalCount)
    expect(
      f.db.settleWorkerReport({
        taskId: started.taskId,
        dispatchId: started.dispatchId,
        outcome: 'succeeded',
        result: 'initial work done'
      }).action
    ).toBe('settled')
    if (from === 'term_worker') {
      const creatorId = f.db.getDispatchContextById(started.dispatchId)?.creator_dispatch_id
      expect(f.db.getWorkerDispatch(creatorId!)?.state).toBe('ready')
      expect(f.db.getDispatchContextById(creatorId!)?.assignee_handle).toBe('term_worker')
      expect(f.db.getRunMailboxOwnerIdsForHandle(target)).toEqual([])
    }
    const snapshot = f.runtime.getOrchestrationCrewSnapshot(from)
    const row = snapshot.sections.managing.find(
      (item) => item.openTarget?.kind === 'terminal' && item.openTarget.handle === target
    )
    expect(row).toMatchObject({
      role: 'worker',
      task: { state: 'completed' },
      openTarget: { kind: 'terminal', handle: target }
    })
    expect(JSON.parse(row!.partyKey)).toEqual([expect.any(String), target])
    expect.soft(row?.sendAddress).toBe(`dispatch:${started.dispatchId}`)
    if (!row?.sendAddress) {
      throw new Error('genuine settled worker action missing')
    }
    const beforePrompts = prompt.mock.calls.length
    await f.command(from, 'send', [
      ['to', row.sendAddress],
      ['subject', 'same worker follow-up'],
      ['body', 'follow-up body']
    ])
    const receipt = f.receipts.findLast((entry) => entry.method === 'orchestration.send')?.result
    expect
      .soft(receipt)
      .toMatchObject({ delivery: 'follow_up', followUpOf: started.dispatchId, state: 'ready' })
    const linked = f.db.db
      .prepare('SELECT * FROM dispatch_contexts WHERE follow_up_of_dispatch_id = ?')
      .get(started.dispatchId)
    const followUp = z
      .object({
        id: z.string(),
        task_id: z.string(),
        follow_up_of_dispatch_id: z.literal(started.dispatchId)
      })
      .parse(linked)
    expect(f.db.getWorkerDispatch(followUp.id)?.state).toBe('ready')
    if (from === 'term_worker') {
      const creator = f.db.getDispatchContextById(started.dispatchId)!.creator_dispatch_id
      expect(f.db.getDispatchContextById(followUp.id)?.creator_dispatch_id).toBe(creator)
      expect(f.db.getTask(followUp.task_id)?.parent_id).toBe(
        f.db.getDispatchContextById(creator!)?.task_id
      )
    }
    expect(f.db.getTask(followUp.task_id)?.spec).toContain('follow-up body')
    expect(f.db.getWorkerTerminalResourceByOwner(followUp.id)).toMatchObject({
      id: resource!.id,
      owner_dispatch_id: followUp.id,
      terminal_handle: target,
      process_incarnation: `process:${target}`
    })
    expect(create).toHaveBeenCalledTimes(terminalCount)
    expect(prompt.mock.calls.slice(beforePrompts)).toHaveLength(1)
    expect(prompt.mock.calls.at(-1)?.[0]).toBe(target)
  } finally {
    f.close()
  }
})
