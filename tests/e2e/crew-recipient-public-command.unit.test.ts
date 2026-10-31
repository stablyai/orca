import { resolveOrcaSessionParty } from '../../src/main/runtime/orchestration/orchestration-party'
import {
  meterCrewSql,
  sqlTotals
} from '../../src/main/runtime/orchestration/crew/crew-recipient-sql.test-fixture'
import { subscribeCrew } from '../../src/main/runtime/orchestration/crew/crew-stream'
import { CrewFrame, type OrchestrationCrewFrame } from '../../src/shared/orchestration-crew'
import { releaseAgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store-slot'
import { testOrcaSessionId } from '../../src/shared/orca-session-address-test-fixture'
import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { dispatch } from '../../src/cli/dispatch'
import { RuntimeClient, RuntimeClientError } from '../../src/cli/runtime-client'
import { readOrchestrationCompatibilityEvidence } from '../../src/shared/orchestration-compatibility-evidence'
import {
  createSessionCallerHarness,
  orchestrationRequest,
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
  const ref: { current: unknown } = { current: null }
  const h = createSessionCallerHarness(ref)
  h.records.clear()
  hostRef.current = ref.current
  const panes = new Map([
    ['term_worker', WORKER_PANE],
    ['term_peer', 'tab_peer:cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ['term_helper', 'tab_helper:dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    ['term_coord', 'tab_coord:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
    ...extraPanes
  ])
  if (actualIdentity) {
    vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
    vi.mocked(h.runtime.getLiveTerminalPaneKey).mockRestore()
    const surfaces = [...panes].map(([handle, pane]) => {
      const [tabId, leafId] = pane.split(':')
      if (!tabId || !leafId) {
        throw new Error('invalid terminal fixture pane')
      }
      return { handle, tabId, leafId, ptyId: `pty_crew_${handle}` }
    })
    for (const surface of surfaces) {
      h.runtime.registerPty(surface.ptyId, 'folder-worker-host', null, {
        tabId: surface.tabId,
        leafId: surface.leafId,
        incarnationId: 'original',
        terminalHandle: surface.handle
      })
    }
    h.runtime.attachWindow(1)
    h.runtime.syncWindowGraph(1, {
      tabs: surfaces.map((surface) => ({
        tabId: surface.tabId,
        worktreeId: 'folder-worker-host',
        title: 'Terminal',
        activeLeafId: surface.leafId,
        layout: null
      })),
      leaves: surfaces.map((surface) => ({
        tabId: surface.tabId,
        worktreeId: 'folder-worker-host',
        leafId: surface.leafId,
        paneRuntimeId: 1,
        ptyId: surface.ptyId
      }))
    })
  } else {
    vi.spyOn(h.runtime, 'getTerminalPaneKey').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(h.runtime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(h.runtime, 'getPaneKeyForTerminalHandle').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockImplementation(
      (pane) => [...panes].find(([, value]) => value === pane)?.[0] ?? null
    )
    vi.spyOn(h.runtime, 'getTerminalWorktreeIdForHandle').mockImplementation((handle) =>
      panes.has(handle) ? 'folder-worker-host' : null
    )
    vi.spyOn(h.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      panes.has(handle) ? `process:${handle}` : null
    )
  }
  vi.spyOn(h.runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
  vi.spyOn(h.runtime, 'getOrchestrationFleetAgentStatusSnapshot').mockReturnValue([])
  const delivery = vi
    .spyOn(h.runtime, 'deliverPendingMessagesForHandle')
    .mockImplementation(() => {})
  const notify = vi.spyOn(h.runtime, 'notifyMessageArrived')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const client = new RuntimeClient('/tmp/crew-all-row-contract', 1000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (method: string, params: unknown) => {
    hostRef.current = ref.current
    const response = await h.dispatch(
      orchestrationRequest(method, z.record(z.string(), z.unknown()).parse(params), {
        evidence: readOrchestrationCompatibilityEvidence({
          ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE,
          ORCA_PANE_KEY: process.env.ORCA_PANE_KEY
        })
      })
    )
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message)
    }
    return { ...response, result: response.result, _meta: { runtimeId: h.runtime.getRuntimeId() } }
  })
  const command = async (from: string, name: string, entries: [string, string | boolean][]) => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', from)
    vi.stubEnv('ORCA_PANE_KEY', panes.get(from) ?? '')
    await dispatch(['orchestration', name], {
      client,
      flags: new Map<string, string | boolean>([...entries, ['from', from]]),
      cwd: '/tmp',
      json: true
    })
  }
  const send = (from: string, to: string, subject: string) =>
    command(from, 'send', [
      ['to', to],
      ['subject', subject],
      ['body', 'hello']
    ])
  const mail = () => h.db.db.prepare('SELECT * FROM messages ORDER BY sequence').all()
  const effects = () =>
    structuredClone({ mail: mail(), delivery: delivery.mock.calls, notify: notify.mock.calls })
  return {
    ...h,
    panes,
    command,
    send,
    mail,
    effects,
    close: () => {
      h.close()
      hostRef.current = null
    }
  }
}

it('publishes a live same-party creator/Managing fallback while retaining explicit settled refusal and Run semantics', async () => {
  const f = ordinaryCrewCommandFixture()
  try {
    await f.command('term_coord', 'run-create', [['objective', 'all-row authority']])
    const run = f.db.getCurrentRunForPane(f.panes.get('term_coord')!)
    if (!run) {
      throw new Error('ordinary run-create did not bind its producer')
    }
    const assign = (handle: string, creator: string) => {
      const task = f.db.createTask({ runId: run.id, spec: 'retained creator' })
      f.db.updateTaskStatus(task.id, 'ready')
      return f.db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: handle,
        assigneePaneKey: f.panes.get(handle),
        processIncarnation: `process:${handle}`,
        creator: { kind: 'terminal', handle: creator, paneKey: f.panes.get(creator) },
        maxDepth: 10
      })
    }
    const creator = assign('term_helper', 'term_coord')
    assign('term_worker', 'term_helper')
    f.db.completeDispatch(creator.id)
    const managing = f.runtime
      .getOrchestrationCrewSnapshot('term_coord')
      .sections.managing.find(
        (row) => row.openTarget?.kind === 'terminal' && row.openTarget.handle === 'term_helper'
      )
    expect(managing?.sendAddress).toBe('term_helper')
    // Same real producer after the Managing window: retained direct creator identity survives.
    f.db.db
      .prepare('UPDATE dispatch_contexts SET completed_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', creator.id)
    const manager = f.runtime.getOrchestrationCrewSnapshot('term_worker').sections.managedBy[0]
    expect(manager).toMatchObject({
      sendAddress: 'term_helper',
      openTarget: { kind: 'terminal', handle: 'term_helper' }
    })
    const before = f.effects()
    await expect(
      f.send('term_worker', `dispatch:${creator.id}`, 'refused original explicit')
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
    expect(f.effects()).toEqual(before)
    if (!manager?.sendAddress || !managing?.sendAddress) {
      throw new Error('same-party action missing')
    }
    await f.send('term_worker', manager.sendAddress, 'published retained creator')
    await f.send('term_coord', managing.sendAddress, 'published settled Managing')
    expect(f.mail().filter((row) => row.subject === 'published retained creator')).toEqual([
      expect.objectContaining({
        to_handle: 'term_helper',
        from_handle: 'term_worker',
        run_id: run.id
      })
    ])
    expect(f.mail().filter((row) => row.subject === 'published settled Managing')).toEqual([
      expect.objectContaining({
        to_handle: 'term_helper',
        from_handle: 'term_coord',
        run_id: run.id
      })
    ])
    const semanticTask = f.db.createTask({
      runId: run.id,
      spec: 'coordinator-derived semantic Run'
    })
    f.db.updateTaskStatus(semanticTask.id, 'ready')
    f.db.createDispatchContext({
      taskId: semanticTask.id,
      assigneeHandle: 'term_peer',
      assigneePaneKey: f.panes.get('term_peer'),
      processIncarnation: 'process:term_peer',
      creator: { kind: 'system' },
      maxDepth: 10
    })
    const semantic = f.runtime.getOrchestrationCrewSnapshot('term_peer').sections.managedBy[0]
    expect(semantic?.sendAddress).toBe(`run:${run.id}`)
    await f.send('term_peer', semantic.sendAddress!, 'semantic Run remains Run')
    expect(f.mail().filter((row) => row.subject === 'semantic Run remains Run')).toEqual([
      expect.objectContaining({ to_handle: `run:${run.id}` })
    ])
    const activeWorker = f.runtime.getOrchestrationCrewSnapshot('term_helper').sections.managing[0]
    expect(activeWorker?.sendAddress).toMatch(/^dispatch:/)
    await f.command('term_coord', 'run-create', [['objective', 'different caller Run']])
    expect(f.db.getCurrentRunForPane(f.panes.get('term_coord')!)?.id).not.toBe(run.id)
    await f.send(
      'term_coord',
      activeWorker.sendAddress!,
      'explicit target ignores different caller Run'
    )
    expect(
      f.mail().filter((row) => row.subject === 'explicit target ignores different caller Run')
    ).toEqual([expect.objectContaining({ to_handle: activeWorker.sendAddress })])
    const callerRun = f.db.getCurrentRunForPane(f.panes.get('term_coord')!)
    if (!callerRun) {
      throw new Error('different caller Run missing')
    }
    const callerTask = f.db.createTask({
      runId: callerRun.id,
      spec: 'retained legacy caller scope'
    })
    f.db.updateTaskStatus(callerTask.id, 'ready')
    f.db.createDispatchContext({
      taskId: callerTask.id,
      assigneeHandle: 'term_helper',
      assigneePaneKey: f.panes.get('term_helper'),
      processIncarnation: 'process:term_helper',
      creator: { kind: 'system' },
      maxDepth: 10
    })
    f.db.db.prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(callerRun.id)
    const explicit = f.runtime.getOrchestrationCrewSnapshot('term_helper').sections.managing[0]
    expect(explicit?.sendAddress).toBe(activeWorker.sendAddress)
    await f.send(
      'term_helper',
      explicit.sendAddress!,
      'explicit target bypasses refused bare inference'
    )
    expect(
      f.mail().filter((row) => row.subject === 'explicit target bypasses refused bare inference')
    ).toEqual([expect.objectContaining({ to_handle: activeWorker.sendAddress, run_id: run.id })])
  } finally {
    f.close()
  }
})

it('qualifies ordinary terminal history from real create/use producers and restores on a real owner wake without new mail', async () => {
  const f = ordinaryCrewCommandFixture()
  let stop: (() => void) | undefined
  try {
    await f.command('term_worker', 'run-create', [['objective', 'S Run']])
    const rs = f.db.getCurrentRunForPane(WORKER_PANE)
    await f.command('term_peer', 'run-create', [['objective', 'T R1']])
    const r1 = f.db.getCurrentRunForPane(f.panes.get('term_peer')!)
    await f.command('term_peer', 'run-create', [['objective', 'T R2']])
    const r2 = f.db.getCurrentRunForPane(f.panes.get('term_peer')!)
    if (!rs || !r1 || !r2) {
      throw new Error('ordinary Run producers missing')
    }
    expect(f.db.runsBoundToPane(f.panes.get('term_peer')!).map((run) => run.id)).toEqual([
      r2.id,
      r1.id
    ])
    await f.command('term_helper', 'run-use', [['id', r1.id]])
    await f.command('term_coord', 'run-use', [['id', r2.id]])
    expect(f.db.runsBoundToPane(f.panes.get('term_peer')!)).toEqual([])
    expect(f.db.getRunMailboxOwnerIdsForHandle('term_peer').sort()).toEqual([r1.id, r2.id].sort())
    await f.send('term_peer', 'term_worker', 'peer after BOTH moves')
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
    const peer = () => current.sections.talkingWith.find((row) => row.latest?.preview === 'hello')
    expect(peer()).toMatchObject({
      latest: { direction: 'from' },
      openTarget: { kind: 'terminal', handle: 'term_peer' }
    })
    expect(peer()).not.toHaveProperty('sendAddress')
    const before = f.effects()
    await expect(f.send('term_worker', 'term_peer', 'ambiguous control')).rejects.toMatchObject({
      code: 'recipient_ambiguous'
    })
    expect(f.effects()).toEqual(before)
    const mailCount = f.mail().length
    const completed = frames.filter((frame) => frame.type === 'complete').length
    await f.command('term_peer', 'run-use', [['id', r2.id]])
    await Promise.resolve()
    expect(f.mail()).toHaveLength(mailCount)
    expect(frames.filter((frame) => frame.type === 'complete').length).toBeGreaterThan(completed)
    expect(peer()?.sendAddress).toBe('term_peer')
    if (!peer()?.sendAddress) {
      throw new Error('real owner wake did not restore the action')
    }
    await f.send('term_worker', peer()!.sendAddress!, 'published restored peer')
    expect(f.mail().filter((row) => row.subject === 'published restored peer')).toEqual([
      expect.objectContaining({
        from_handle: 'term_worker',
        to_handle: `run:${r2.id}`,
        run_id: r2.id
      })
    ])
    process.stdout.write(
      `C2 all-row ordinary producer ${JSON.stringify({ rs: rs.id, r1: r1.id, r2: r2.id, frames, output: current })}\n`
    )
    const count = frames.length
    stop()
    stop = undefined
    f.db.insertMessage({ from: 'term_peer', to: 'term_worker', subject: 'after release' })
    await Promise.resolve()
    expect(frames).toHaveLength(count)
  } finally {
    stop?.()
    f.close()
  }
})

it('keeps unique remembered Run authority after real target retirement and still refuses a retired terminal without an owner', async () => {
  const f = ordinaryCrewCommandFixture(true)
  let stop: (() => void) | undefined
  let meter: ReturnType<typeof meterCrewSql> | undefined
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
    meter = meterCrewSql(f.db.db)
    const liveReads = vi.spyOn(f.runtime, 'getLiveTerminalPaneKey')
    const processReads = vi.spyOn(f.runtime, 'getTerminalProcessIncarnation')
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
    const liveBefore = liveReads.mock.calls.length
    const processBefore = processReads.mock.calls.length
    meter.control.phase = 'retirement'
    f.runtime.onPtySpawned('pty_crew_term_peer', 'replacement', { awaitsRegistration: false })
    f.runtime.onPtySpawned('pty_crew_term_coord', 'replacement', { awaitsRegistration: false })
    await Promise.resolve()
    await Promise.resolve()
    const retiredReads = meter.executions.filter((entry) => entry.phase === 'retirement')
    meter.control.phase = 'checks'
    const downstream = {
      liveReads: liveReads.mock.calls.length - liveBefore,
      processReads: processReads.mock.calls.length - processBefore
    }
    const historyReads = retiredReads.filter((entry) =>
      entry.sql.includes('coordinator.run_id FROM json_each')
    )
    const historyHandles = historyReads.flatMap((entry) => {
      if (typeof entry.parameters[0] !== 'string') {
        throw new Error('history batch request missing')
      }
      return z
        .array(z.object({ handle: z.string() }))
        .parse(JSON.parse(entry.parameters[0]))
        .map((key) => key.handle)
    })
    expect(historyHandles).toEqual(expect.arrayContaining(['term_peer', 'term_coord']))
    expect(historyReads.flatMap((entry) => entry.results)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'term_peer', run_id: rt.id })])
    )
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
    process.stdout.write(
      `C2 retired terminal durable authority ${JSON.stringify({ rs: rs.id, rt: rt.id, frames, output: current, retiredReads, totals: sqlTotals(retiredReads), historyHandles, downstream })}\n`
    )
    const count = frames.length
    stop()
    stop = undefined
    f.runtime.onPtySpawned('pty_crew_term_peer', 'after-release', { awaitsRegistration: false })
    await Promise.resolve()
    expect(frames).toHaveLength(count)
  } finally {
    stop?.()
    meter?.restore()
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
    process.stdout.write(
      `C2 hybrid identity command ${JSON.stringify({ currentProcess, historical, snapshot, row, messages: f.mail(), refusalEffectsUnchanged: true })}\n`
    )
  } finally {
    f.close()
  }
})
