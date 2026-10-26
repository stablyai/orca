import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeHookPayload,
  prepareJcodeHookPayload,
  prepareJcodeRootSettlement
} from './agent-hook-listener'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  clearPaneTurnCacheState,
  createHookListenerState,
  movePaneCacheState,
  paneHasStateClaims,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  bindJcodeRootSession,
  bindJcodeWorkerSession,
  takeResolvedJcodeEvents
} from './agent-hook-listener/jcode-session-registry'
import { prepareJcodeState } from './agent-hook-listener/jcode-prepared-state'
import { ingestPreparedJcodeHooks } from './agent-hook-listener/jcode-hook-ingress'
import { seedJcodeStateFromSnapshot } from './agent-hook-listener/providers/jcode-roster-state'
import { reduceHostTurnEnd } from './agent-hook-turn-end-timing'
import {
  dolphinHooks,
  rootMetadata,
  tigressHooks,
  workerMetadata
} from './agent-hook-listener-jcode-swarm-fixtures'

vi.mock('node:fs', async (importOriginal) => {
  // oxlint-disable-next-line typescript/consistent-type-imports -- importOriginal types real module
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, openSync: vi.fn(actual.openSync) }
})

const rootId = rootMetadata.id
const workerId = workerMetadata.id
function hook(event: string, id: string = workerId): Record<string, unknown> {
  const found = tigressHooks.find((item) => item.event === event && item.session_id === id)
  if (!found) {
    throw new Error(`Missing captured ${event} ${id}`)
  }
  return { ...found }
}
// Negative controls: root turn boundaries use captured worker shapes with root id/model.
const rootStart = { ...hook('turn_start'), session_id: rootId, model: rootMetadata.model }
const rootEnd = { ...hook('turn_end'), session_id: rootId, last_assistant_text: 'root done' }
const rootSpawn = tigressHooks.find(
  (item) => item.event === 'post_tool' && item.tool_name === 'swarm'
)
if (!rootSpawn) {
  throw new Error('Missing captured spawn')
}

describe('Jcode attributed swarm normalization', () => {
  let home: string
  let state: HookListenerState
  const accept = (payload: Record<string, unknown>) => normalizeAndAccept(state, 'jcode', payload)
  function metadata(value: { id: string } & Record<string, unknown>) {
    writeFileSync(join(home, 'sessions', `${value.id}.json`), JSON.stringify(value))
  }
  function journal(id: string, text: string) {
    writeFileSync(
      join(home, 'sessions', `${id}.journal.jsonl`),
      JSON.stringify({
        meta: { id },
        append_messages: [{ id: 'm1', role: 'user', content: text }]
      })
    )
  }
  function start() {
    const event = accept(rootStart)
    expect(event?.payload.state).toBe('working')
    if (!event) {
      throw new Error('Root turn refused')
    }
    return event
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    home = mkdtempSync(join(tmpdir(), 'orca-jcode-swarm-'))
    mkdirSync(join(home, 'sessions'))
    vi.stubEnv('JCODE_HOME', home)
    state = createHookListenerState()
    metadata(rootMetadata)
    metadata(workerMetadata)
    journal(rootId, 'Root user request')
    journal(workerId, workerMetadata.title)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps root prompt, model, caches and resume identity through captured child lifecycle', () => {
    // Negative control: distinct turn models expose cross-session model leakage.
    const rootBefore = accept({ ...rootStart, model: 'claude-opus-5-5' })
    if (!rootBefore) {
      throw new Error('Root turn refused')
    }
    accept({ ...hook('post_tool', rootId), tool_name: 'bash' })
    const prompt = state.jcodeTurnPromptByPaneKey.get(PANE_KEY)
    const tool = state.lastToolByPaneKey.get(PANE_KEY)
    const turn = state.jcodeTurnByPaneKey.get(PANE_KEY)
    const rootPayload = state.jcodeRootPayloadByPaneKey.get(PANE_KEY)
    const childCreated = accept(hook('session_start'))
    expect(childCreated?.providerSessionOnly).toBeUndefined()
    expect(childCreated?.payload.subagents?.[0]).toMatchObject({
      state: 'idle',
      agentType: 'retriever'
    })
    expect(childCreated?.payload.subagents?.[0]?.model).toBeUndefined()
    expect(state.jcodeTurnPromptByPaneKey.get(PANE_KEY)).toBe(prompt)
    expect(state.lastToolByPaneKey.get(PANE_KEY)).toBe(tool)
    expect(state.jcodeTurnByPaneKey.get(PANE_KEY)).toBe(turn)
    expect(state.jcodeRootPayloadByPaneKey.get(PANE_KEY)).toBe(rootPayload)
    const workerStart = accept(hook('turn_start'))
    expect(workerStart?.providerSession).toEqual({ key: 'session_id', id: rootId })
    expect(workerStart?.payload.prompt).toBe(rootBefore.payload.prompt)
    expect(workerStart?.payload.model).toBe(rootBefore.payload.model)
    expect(workerStart?.payload.mainAgent).toEqual(rootBefore.payload.mainAgent)
    expect(workerStart?.payload.subagents).toEqual([
      expect.objectContaining({
        id: workerId,
        agentType: 'retriever',
        description: workerMetadata.title,
        model: 'claude-haiku-5-5',
        state: 'working'
      })
    ])
    for (const event of [childCreated, workerStart, accept(hook('turn_end'))]) {
      expect(event?.payload.model).toBe(rootBefore.payload.model)
      expect(event?.hookEventName).toBeUndefined()
      expect(event?.hasExplicitPrompt).toBeUndefined()
      expect(event?.promptInteractionKey).toBeUndefined()
      expect(event?.nativeTurnKey).toBeUndefined()
      expect(event?.turnEndedAt).toBeUndefined()
      expect(event?.payload.lastAssistantMessage).toBeUndefined()
    }
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.subagents?.[0]?.state).toBe('idle')
    // Negative control: close shape from captured octopus, same retriever owner.
    const closed = accept({ ...hook('session_start'), event: 'session_end', source: 'close' })
    expect(closed?.payload.subagents).toBeUndefined()
    expect(closed?.payload.mainAgent).toEqual(rootBefore.payload.mainAgent)
  })

  it('folds a finished root with child work without a second root boundary', () => {
    start()
    // Negative control: captured post_tool arguments replayed as pre_tool to cache root detail.
    accept({ ...hook('post_tool', rootId), event: 'pre_tool' })
    accept(hook('turn_start'))
    const ended = accept(rootEnd)
    expect(ended?.payload).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    const cached = state.jcodeRootPayloadByPaneKey.get(PANE_KEY)
    expect(cached).toMatchObject({
      lastAssistantMessage: 'root done',
      toolName: 'bash',
      toolInput: 'rtk ls'
    })
    const idle = accept(hook('turn_end'))
    expect(idle?.payload).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(idle?.hookEventName).toBeUndefined()
    expect(idle?.payload.lastAssistantMessage).toBe('root done')
    for (const field of ['lastAssistantMessage', 'toolName', 'toolInput'] as const) {
      expect(idle?.payload[field]).toBe(cached?.[field])
    }
  })

  it.each(['pre_tool', 'post_tool', 'report'])(
    'drops known worker %s without roster membership',
    (eventName) => {
      start()
      expect(bindJcodeWorkerSession(state, PANE_KEY, rootId, workerId, 'session-file')).toBe(true)
      const report = dolphinHooks.find(
        (item) => item.event === 'post_tool' && item.session_id.includes('octopus')
      )
      if (!report) {
        throw new Error('Missing report capture')
      }
      // Negative controls: known worker has no lifecycle entry; report uses its owner id.
      const payload =
        eventName === 'report'
          ? { ...report, session_id: workerId }
          : { ...hook('post_tool', rootId), session_id: workerId, event: eventName }
      const prepared = prepareJcodeHookPayload(state, { paneKey: PANE_KEY, payload }, 'production')
      expect(prepared?.resolution.kind).toBe('worker')
      expect(prepared?.event).toBeNull()
      prepared?.commit()
      expect(state.jcodeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.subagents).toBeUndefined()
    }
  )

  it('unresolved input returns null without reading its journal', () => {
    // Negative control: journal exists but no ownership document.
    journal('unknown', 'must never become root prompt')
    vi.mocked(openSync).mockClear()
    expect(accept({ ...rootStart, session_id: 'unknown' })).toBeNull()
    const opened = vi.mocked(openSync).mock.calls.map(([path]) => String(path))
    expect(opened.some((path) => path.endsWith('.journal.jsonl'))).toBe(false)
    expect(state.lastStatusByPaneKey.size).toBe(0)
  })

  it('retains known child before first real root turn without fabricating a row', () => {
    expect(accept(hook('session_start', rootId))?.providerSessionOnly).toBe(true)
    expect(accept(hook('turn_start'))).toBeNull()
    expect(state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.get(workerId)?.state).toBe('working')
    expect(start().payload.subagents?.[0]?.state).toBe('working')
  })

  it('spawn_post_tool_never_labels_a_worker', () => {
    start()
    // Negative control: second worker with identical title/prompt but distinct codename/id.
    const workerB = 'session_second_worker'
    metadata({ ...workerMetadata, id: workerB, short_name: 'octopus' })
    accept({ ...hook('turn_start'), session_id: workerB })
    const beforeA = accept(rootSpawn)
    expect(beforeA?.payload.subagents).toEqual([
      expect.objectContaining({ id: workerB, agentType: 'octopus' })
    ])
    const afterA = accept(hook('turn_start'))
    expect(afterA?.payload.subagents?.map((child) => [child.id, child.agentType])).toEqual([
      [workerId, 'retriever'],
      [workerB, 'octopus']
    ])
  })

  it('records captured report on known worker without ending turn; clears only on next turn', () => {
    const dolphin = dolphinHooks.find((item) => item.event === 'session_start')
    const octopus = dolphinHooks.find((item) => item.event === 'turn_start')
    if (!dolphin || !octopus) {
      throw new Error('Missing lifecycle capture')
    }
    metadata({ id: dolphin.session_id, parent_id: null, status: 'Active' })
    metadata({
      id: octopus.session_id,
      parent_id: dolphin.session_id,
      short_name: 'octopus',
      title: 'Reply with exactly: w4-ok',
      status: 'Active'
    })
    // Negative control: headless root capture has no turn_start; open one for root-status assertions.
    accept({ ...octopus, session_id: dolphin.session_id })
    for (const payload of dolphinHooks) {
      accept(payload)
      if (payload.session_id !== octopus.session_id) {
        continue
      }
      const worker = state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.get(octopus.session_id)
      if (payload.event === 'post_tool' || payload.event === 'turn_end') {
        expect(worker?.report).toBe('w4 lane complete. Replied with requested sentinel.')
        expect(worker?.state).toBe(payload.event === 'post_tool' ? 'working' : 'idle')
      }
      if (payload.event === 'turn_end') {
        accept(octopus)
        expect(
          state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.get(octopus.session_id)?.report
        ).toBeUndefined()
      }
    }
    expect(state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.size ?? 0).toBe(0)
  })

  it.each([
    { status: 'error' },
    { tool_name: 'bash' },
    { tool_input: '{' },
    { tool_input: '{"action":"spawn","message":"wrong"}' },
    { tool_input: '{"action":"report","message":"  "}' },
    { tool_input: '{"action":"report","message":7}' }
  ])('ignores malformed or failed worker report: %j', (mutation) => {
    start()
    accept(hook('turn_start'))
    const report = dolphinHooks.find(
      (item) => item.event === 'post_tool' && item.session_id.includes('octopus')
    )
    if (!report) {
      throw new Error('Missing report capture')
    }
    // Negative controls: report owner and one malformed field.
    accept({ ...report, session_id: workerId, ...mutation })
    expect(state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.get(workerId)?.report).toBeUndefined()
  })

  it.each([
    ['cancel_settle_then_worker_event_keeps_root_done', false],
    ['cancel_settle_with_active_child_stays_working_until_child_idle', true]
  ] as const)('%s', (_name, active) => {
    start()
    accept(hook(active ? 'turn_start' : 'session_start'))
    const turn = state.jcodeTurnByPaneKey.get(PANE_KEY)
    if (!turn) {
      throw new Error('Missing root turn')
    }
    const settled = prepareJcodeRootSettlement(state, PANE_KEY, rootId, turn.revision)
    expect(settled?.payload).toMatchObject({
      state: active ? 'working' : 'done',
      mainAgent: { state: 'done' }
    })
    settled?.commit()
    const report = dolphinHooks.find(
      (item) => item.event === 'post_tool' && item.session_id.includes('octopus')
    )
    if (!report) {
      throw new Error('Missing report')
    }
    const reported = accept({ ...report, session_id: workerId })
    expect(reported?.payload).toMatchObject({
      state: active ? 'working' : 'done',
      mainAgent: { state: 'done' }
    })
    expect(reported?.payload.mainAgent).toEqual(settled?.payload.mainAgent)
    expect(reported?.hookEventName).toBeUndefined()
    expect(reported?.hasExplicitPrompt).toBeUndefined()
    expect(reported?.promptInteractionKey).toBeUndefined()
    expect(accept(hook('turn_end'))?.payload).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done' }
    })
    expect(accept(hook('post_tool', rootId))).toBeNull()
    expect(start().payload.mainAgent?.state).toBe('working')
  })

  it('preview does not consume ownership, turns, roster or prompt caches', () => {
    const before = structuredClone({
      ...state,
      lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
    })
    expect(
      normalizeHookPayload(state, 'jcode', { paneKey: PANE_KEY, payload: rootStart }, 'production')
        ?.payload.state
    ).toBe('working')
    expect(
      structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
    ).toEqual(before)
  })

  it('consumes a resolved stale tool before a later turn can admit it', () => {
    rmSync(join(home, 'sessions', `${rootId}.json`))
    const ingest = (payload: Record<string, unknown>) =>
      ingestPreparedJcodeHooks(
        state,
        { body: { paneKey: PANE_KEY, payload }, receivedAt: Date.now() },
        (input) => prepareJcodeHookPayload(state, input.body, 'production', input),
        (prepared) => {
          if (prepared.event) {
            seedLegacyAgentStatusForTests(state, prepared.event)
          }
          prepared.commit()
        }
      )
    // Negative control: root post_tool arrives without a turn or readable document.
    ingest({ ...hook('post_tool', rootId), tool_name: 'stale-tool' })
    expect(state.jcodeSessions.pending).toHaveLength(1)
    metadata(rootMetadata)
    vi.advanceTimersByTime(250)
    ingest(rootStart)
    expect(state.jcodeSessions.pending).toEqual([])
    ingest(hook('session_start'))
    expect(state.lastToolByPaneKey.get(PANE_KEY)?.toolName).toBeUndefined()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.toolName).toBeUndefined()
  })

  it.each(['recent-status', 'process-owner'])(
    'rejects a foreign %s before opening session storage',
    (owner) => {
      const root = start()
      // Negative control: another live provider owns this terminal.
      seedLegacyAgentStatusForTests(state, {
        ...root,
        source: 'claude',
        ...(owner === 'recent-status'
          ? { hostEvidenceObservedAt: Date.now() }
          : {
              agentPresence: {
                agent: 'claude',
                sessionOwner: true,
                process: { pid: 1234, startTime: 'owner', platform: 'linux' as const }
              }
            }),
        payload: { ...root.payload, agentType: 'claude' }
      })
      vi.mocked(openSync).mockClear()
      expect(
        prepareJcodeHookPayload(
          state,
          { paneKey: PANE_KEY, payload: hook('session_start') },
          'production'
        )
      ).toBeNull()
      expect(openSync).not.toHaveBeenCalled()
    }
  )

  it('commits accepted input once without replacing host row or unrelated caches', () => {
    const body = { paneKey: PANE_KEY, payload: rootStart, launchToken: 'accepted-launch' }
    const prepared = prepareJcodeHookPayload(state, body, 'production')
    expect(prepared?.event?.payload.state).toBe('working')
    expect(state.jcodeTurnByPaneKey.size).toBe(0)
    expect(state.jcodeSessions.roots.size).toBe(0)
    if (!prepared?.event) {
      throw new Error('Missing prepared turn')
    }
    const accepted = { ...prepared.event, hostTurnRevision: 'host-owned' }
    seedLegacyAgentStatusForTests(state, accepted)
    state.lastToolByPaneKey.set('other-pane', { toolName: 'other-tool' })
    prepared.commit()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.hostTurnRevision).toBe('host-owned')
    expect(state.lastToolByPaneKey.get('other-pane')?.toolName).toBe('other-tool')
    accept(rootEnd)
    prepared.commit()
    expect(state.jcodeTurnByPaneKey.get(PANE_KEY)?.active).toBe(false)
    expect(state.jcodeRootPayloadByPaneKey.get(PANE_KEY)?.state).toBe('done')
  })

  it('commits envelope warning suppression only after acceptance', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const body = {
        paneKey: PANE_KEY,
        payload: rootStart,
        version: 'old-version',
        env: 'other-install'
      }
      const prepared = prepareJcodeHookPayload(state, body, 'production')
      expect(state.warnedVersions.size).toBe(0)
      expect(state.warnedEnvs.size).toBe(0)
      prepared?.commit()
      expect(state.warnedVersions.has('old-version')).toBe(true)
      expect(state.warnedEnvs.has('other-install->production')).toBe(true)
      prepareJcodeHookPayload(state, body, 'production')
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('buffers only accepted envelope and dequeues only accepted delivery with original facts', () => {
    // Negative control: worker arrives before root ownership is known.
    const body = { paneKey: PANE_KEY, payload: hook('turn_start'), launchToken: 'original-launch' }
    const options = { receivedAt: 900, isReplay: true }
    const pending = prepareJcodeHookPayload(state, body, 'production', options)
    expect(pending?.resolution.kind).toBe('pending')
    expect(state.jcodeSessions.pending).toEqual([])
    pending?.commit()
    expect(state.jcodeSessions.pending[0]?.input).toEqual({ body, ...options })
    start()
    const [input] = takeResolvedJcodeEvents(state, PANE_KEY)
    expect(input?.body).toBe(body)
    const worker = prepareJcodeHookPayload(state, input?.body, 'production', input)
    expect(worker?.event?.isReplay).toBe(true)
    expect(worker?.event?.launchToken).toBe('original-launch')
    expect(worker?.event?.providerSession?.id).toBe(rootId)
    expect(state.jcodeSessions.pending).toHaveLength(1)
    worker?.commit()
    worker?.commit()
    expect(state.jcodeSessions.pending).toEqual([])
  })

  it('re-resolves queued parentless candidates against each committed owner', () => {
    // Negative control: two missing sessions become readable as unrelated roots together.
    const ids = ['candidate-one', 'candidate-two']
    for (const id of ids) {
      accept({ ...rootStart, session_id: id })
    }
    for (const id of ids) {
      metadata({ ...rootMetadata, id })
    }
    vi.advanceTimersByTime(250)
    const inputs = takeResolvedJcodeEvents(state, PANE_KEY)
    expect(inputs).toHaveLength(2)
    const first = prepareJcodeHookPayload(state, inputs[0].body, 'production', inputs[0])
    first?.commit()
    const second = prepareJcodeHookPayload(state, inputs[1].body, 'production', inputs[1])
    expect(second?.resolution.kind).toBe('ignored')
    expect(second?.event).toBeNull()
    second?.commit()
    expect(state.jcodeSessions.roots.get(PANE_KEY)).toBe(ids[0])
  })

  it('discards stale preparations after registry replacement', () => {
    const old = prepareJcodeHookPayload(
      state,
      { paneKey: PANE_KEY, payload: rootStart },
      'production'
    )
    bindJcodeRootSession(state, PANE_KEY, 'replacement', 'launch')
    old?.commit()
    expect(state.jcodeSessions.roots.get(PANE_KEY)).toBe('replacement')
    expect(state.jcodeTurnByPaneKey.size).toBe(0)
    expect(state.lastPromptByPaneKey.size).toBe(0)
  })

  it.each(['roster', 'root payload'])(
    'discards stale pane drafts after a %s-only commit',
    (entry) => {
      const root = start()
      const registry = state.jcodeSessions
      const turn = state.jcodeTurnByPaneKey.get(PANE_KEY)
      const first = prepareJcodeState(state, PANE_KEY)
      const second = prepareJcodeState(state, PANE_KEY)
      if (entry === 'roster') {
        first.draft.jcodeSubagentRosterByPaneKey.set(
          PANE_KEY,
          new Map([[workerId, { state: 'working', startedAt: 1000, lastActivityAt: 1000 }]])
        )
      } else {
        first.draft.jcodeRootPayloadByPaneKey.set(PANE_KEY, {
          ...root.payload,
          lastAssistantMessage: 'accepted reply'
        })
      }
      first.commit()
      expect(state.jcodeSessions).toBe(registry)
      expect(state.jcodeTurnByPaneKey.get(PANE_KEY)).toBe(turn)
      const accepted = structuredClone({
        ...state,
        lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
      })
      second.draft.lastToolByPaneKey.set(PANE_KEY, { toolName: 'stale' })
      second.commit()
      expect(
        structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
      ).toEqual(accepted)
    }
  )

  it('prepares settlement privately, guards owner/revision and retains one late reply', () => {
    const started = start()
    const turn = state.jcodeTurnByPaneKey.get(PANE_KEY)
    if (!turn) {
      throw new Error('Missing turn')
    }
    expect(prepareJcodeRootSettlement(state, PANE_KEY, workerId, turn.revision)).toBeNull()
    expect(prepareJcodeRootSettlement(state, PANE_KEY, rootId, turn.revision + 1)).toBeNull()
    const settled = prepareJcodeRootSettlement(state, PANE_KEY, rootId, turn.revision)
    expect(state.jcodeTurnByPaneKey.get(PANE_KEY)?.active).toBe(true)
    expect(state.jcodeRootPayloadByPaneKey.get(PANE_KEY)?.state).toBe('working')
    settled?.commit()
    expect(state.jcodeTurnByPaneKey.get(PANE_KEY)).toMatchObject({ active: false, settled: true })
    const late = accept(rootEnd)
    expect(late?.payload).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done' },
      lastAssistantMessage: 'root done'
    })
    if (!late || !settled) {
      throw new Error('Missing settled late reply')
    }
    const opened = reduceHostTurnEnd(undefined, started, 1000, true)
    const cancelled = {
      ...started,
      ...opened,
      payload: settled.payload,
      hookEventName: undefined
    }
    const end = reduceHostTurnEnd(
      { ...cancelled, ...reduceHostTurnEnd({ ...started, ...opened }, cancelled, 1001, true) },
      late,
      1002,
      true
    )
    expect(end.turnEndedAt).toBeUndefined()
    expect(end.turnEndDisposition).toBeUndefined()
    expect(accept(rootEnd)).toBeNull()
  })

  it('settlement preserves root admission when accepted row belongs to another agent', () => {
    const root = start()
    const turn = state.jcodeTurnByPaneKey.get(PANE_KEY)
    if (!turn) {
      throw new Error('Missing root turn')
    }
    // Negative control: pane switched agents after Jcode last spoke.
    seedLegacyAgentStatusForTests(state, {
      ...root,
      source: 'claude',
      payload: { ...root.payload, agentType: 'claude' }
    })
    expect(prepareJcodeRootSettlement(state, PANE_KEY, rootId, turn.revision)).toBeNull()
    expect(state.jcodeTurnByPaneKey.get(PANE_KEY)?.active).toBe(true)
  })

  it.each(['worker', 'root'])('close %s retires bindings and rejects late reports', (owner) => {
    start()
    accept(hook('turn_start'))
    const report = dolphinHooks.find(
      (item) => item.event === 'post_tool' && item.session_id.includes('octopus')
    )
    if (!report) {
      throw new Error('Missing report')
    }
    const closed = accept({
      ...hook('session_start'),
      event: 'session_end',
      session_id: owner === 'worker' ? workerId : rootId,
      source: 'close'
    })
    expect(closed?.payload.subagents).toBeUndefined()
    const before = state.jcodeSessions
    expect(accept({ ...report, session_id: workerId })).toBeNull()
    expect(state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.size ?? 0).toBe(0)
    expect(state.jcodeSessions.bindings.size).toBe(before.bindings.size)
  })

  it('root replacement clears old caches only on accepted commit and retires queued children', () => {
    // Negative control: ancestry-known worker is pending before root has been observed.
    metadata({ ...workerMetadata, id: 'old-pending' })
    accept({ ...hook('turn_start'), session_id: 'old-pending' })
    start()
    accept(hook('turn_start'))
    expect(state.jcodeSessions.pending).toHaveLength(1)
    // Negative control: explicit launch replaces old root.
    const nextId = 'new-root'
    bindJcodeRootSession(state, PANE_KEY, nextId, 'launch')
    const next = prepareJcodeHookPayload(
      state,
      { paneKey: PANE_KEY, payload: { ...rootStart, session_id: nextId } },
      'production'
    )
    expect(state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.size).toBe(1)
    expect(next?.event?.payload).toMatchObject({ prompt: '', model: rootMetadata.model })
    next?.commit()
    expect(state.jcodeSessions.pending).toEqual([])
    expect(state.jcodeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
    expect(state.lastToolByPaneKey.get(PANE_KEY)?.toolName).toBeUndefined()
    expect(state.jcodeTurnPromptByPaneKey.get(PANE_KEY)).toBeNull()
    expect(accept({ ...rootEnd, session_id: rootId })).toBeNull()
    expect(state.jcodeRootPayloadByPaneKey.get(PANE_KEY)?.state).toBe('working')
  })

  it('replacement before any root turn discards previous root child roster on commit', () => {
    bindJcodeRootSession(state, PANE_KEY, rootId, 'launch')
    expect(accept(hook('turn_start'))).toBeNull()
    expect(state.jcodeTurnByPaneKey.has(PANE_KEY)).toBe(false)
    expect(state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.size).toBe(1)
    bindJcodeRootSession(state, PANE_KEY, 'replacement', 'launch')
    const next = prepareJcodeHookPayload(
      state,
      { paneKey: PANE_KEY, payload: { ...rootStart, session_id: 'replacement' } },
      'production'
    )
    expect(next?.event?.payload.subagents).toBeUndefined()
    expect(state.jcodeSubagentRosterByPaneKey.get(PANE_KEY)?.size).toBe(1)
    next?.commit()
    expect(state.jcodeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('restored working snapshots do not keep a finished root working', () => {
    const root = start()
    seedJcodeStateFromSnapshot(state, PANE_KEY, {
      ...root,
      payload: { ...root.payload, subagents: [{ id: workerId, state: 'working', startedAt: 10 }] }
    })
    const ended = accept(rootEnd)
    expect(ended?.payload).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(accept(hook('turn_start'))?.payload.state).toBe('working')
  })

  it('moves new caches and clears them on pane, turn and listener teardown', () => {
    start()
    accept(hook('turn_start'))
    accept({ ...rootStart, session_id: 'unresolved-session' })
    expect(state.jcodeSessions.pending).toHaveLength(1)
    const moved = 'moved:22222222-2222-4222-8222-222222222222'
    movePaneCacheState(state, PANE_KEY, moved)
    expect(state.jcodeRootPayloadByPaneKey.has(PANE_KEY)).toBe(false)
    expect(state.jcodeSubagentRosterByPaneKey.get(moved)?.size).toBe(1)
    expect(state.jcodeSessions.pending[0]).toMatchObject({
      paneKey: moved,
      input: { body: { paneKey: moved } }
    })
    expect(
      Array.from(state.jcodeSessions.bindings.values()).every(
        (binding) => binding.paneKey === moved
      )
    ).toBe(true)
    clearPaneTurnCacheState(state, moved)
    expect(state.jcodeRootPayloadByPaneKey.has(moved)).toBe(true)
    expect(state.jcodeSubagentRosterByPaneKey.get(moved)?.size).toBe(1)
    expect(state.jcodeSessions.pending).toHaveLength(1)
    clearPaneCacheState(state, moved)
    expect(state.jcodeSubagentRosterByPaneKey.size).toBe(0)
    expect(state.jcodeSessions.pending).toEqual([])
    expect(paneHasStateClaims(state, moved)).toBe(false)
    start()
    accept(hook('turn_start'))
    clearAllListenerCaches(state)
    expect(state.jcodeRootPayloadByPaneKey.size).toBe(0)
    expect(state.jcodeSubagentRosterByPaneKey.size).toBe(0)
  })
})
