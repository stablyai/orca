import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rememberPaneKeyForPty, ptyPaneKey, paneKeyPtyId } from '../main/ipc/pty/pane/key-state'
import { AgentHookServer, _internals } from '../main/agent-hooks/server'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-listener/transport/agent-hook-relay'
import { makePaneKey } from '../shared/workspace-layout/stable-pane-id'

vi.mock('../main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../main/telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const sessionId = '44444444-4444-4444-8444-444444444444'
const promptId = '22222222-2222-4222-8222-222222222222'
const jsonl = (...records: unknown[]) => records.map((row) => `${JSON.stringify(row)}\n`).join('')
const event = (payload: Record<string, unknown>) => ({ type: 'event_msg', payload })
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
  })
  vi.setSystemTime(1_793_751_000_000)
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  vi.useRealTimers()
})

async function start(kind: 'local' | 'guest') {
  _internals.resetCachesForTests()
  const directory = mkdtempSync(join(tmpdir(), 'orca-quota-publication-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'transcript.jsonl')
  let latest: AgentHookRelayEnvelope | undefined
  const local = new AgentHookServer()
  const relay = new RelayAgentHookServer({
    endpointDir: directory,
    forward: (row) => {
      latest = row
      local.ingestRemote(row, 'wsl:Ubuntu')
    }
  })
  const server = kind === 'guest' ? relay : local
  if (kind === 'guest') {
    await local.start({ env: 'production', userDataPath: directory })
    cleanups.push(() => local.stop())
    local.beginRemoteRelaySession('wsl:Ubuntu')
  }
  await (kind === 'guest'
    ? relay.start()
    : local.start({ env: 'production', userDataPath: directory }))
  cleanups.push(() => server.stop())
  const env = kind === 'guest' ? undefined : local.buildPtyEnv()
  const { port, token } =
    kind === 'guest'
      ? relay.getCoordinates()
      : {
          port: env!.ORCA_AGENT_HOOK_PORT,
          token: env!.ORCA_AGENT_HOOK_TOKEN
        }
  return {
    path,
    local,
    sourceRow: () => server['state'].lastStatusByPaneKey.get(paneKey),
    replay: () => relay.replayCachedPayloadsForPanes(),
    validate: (value: unknown) => relay.validateTerminalUsageLimit(value),
    read: () => (kind === 'guest' ? latest : local.getStatusSnapshotForPane(paneKey)[0]),
    post: async (source: 'claude' | 'codex', payload: Record<string, unknown>) => {
      const result = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          Connection: 'close'
        },
        body: JSON.stringify({
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            session_id: sessionId,
            transcript_path: path,
            ...payload
          }
        })
      })
      expect(result.status).toBe(204)
    }
  }
}

it.each(['local', 'guest'] as const)(
  '%s publishes a failed poll-only Codex root end once, without a Stop hook',
  async (kind) => {
    const host = await start(kind)
    writeFileSync(host.path, jsonl(event({ type: 'task_started', turn_id: 'root' })))
    await host.post('codex', {
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'root',
      prompt: 'Finish'
    })
    appendFileSync(
      host.path,
      jsonl(
        event({
          type: 'token_count',
          info: null,
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 100, window_minutes: 300, resets_at: 1_893_756_137 }
          }
        }),
        event({
          type: 'task_complete',
          turn_id: 'root',
          error: { codex_error_info: 'usage_limit_exceeded' }
        })
      )
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.read()?.turnEndedAt).toBeTypeOf('number')
    const failed = host.read()!
    const main = 'payload' in failed ? failed.payload.mainAgent : failed.mainAgent
    expect(main).toMatchObject({ state: 'done', outcome: 'failure', usageLimit: {} })
    expect(failed.turnEndDisposition).toBe('identified')
    if ('payload' in failed) {
      expect(failed.hookEventName).toBeUndefined()
    }
    if (kind === 'guest') {
      const ptyId = 'quota-publication-pty'
      rememberPaneKeyForPty(ptyId, paneKey)
      cleanups.push(() => {
        ptyPaneKey.delete(ptyId)
        paneKeyPtyId.delete(paneKey)
      })
      const cut = { sessionId, turnEndedAt: failed.turnEndedAt! }
      const initial = host.local.prepareTerminalUsageLimitSource(paneKey, ptyId, cut)!
      cleanups.push(() => initial.dispose())
      expect(initial.isCurrent()).toBe(true)
      expect(host.validate(initial.remote!.request)).toEqual({ status: 'current' })
      await host.post('codex', { hook_event_name: 'Stop', turn_id: 'root' })
      host.replay()
      expect(host.local.getStatusSnapshotForPane(paneKey)[0]).toMatchObject({
        mainAgent: main,
        turnEndedAt: failed.turnEndedAt,
        turnEndDisposition: 'identified'
      })
      expect(initial.isCurrent()).toBe(true)
      expect(host.validate(initial.remote!.request)).toEqual({ status: 'current' })
      const movedPane = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
      host.local.transferPaneAuthority(paneKey, movedPane, ptyId, 1_793_751_001_000, {
        authorityVerified: true
      })
      expect(initial.isCurrent()).toBe(false)
      const moved = host.local.prepareTerminalUsageLimitSource(movedPane, ptyId, cut)!
      cleanups.push(() => moved.dispose())
      expect(moved.isCurrent()).toBe(true)
      expect(moved.remote!.request.paneKey).toBe(paneKey)
      expect(host.validate(moved.remote!.request)).toEqual({ status: 'current' })
      host.local.beginRemoteRelaySession('wsl:Ubuntu')
      expect(moved.isCurrent()).toBe(false)
    }

    await host.post('codex', { hook_event_name: 'Stop', turn_id: 'root' })
    expect(host.read()?.turnEndedAt).toBe(failed.turnEndedAt)
  }
)

it.each(['refine', 'new-meta-root', 'new-session'] as const)(
  'guest delayed Claude quota with existing text: %s',
  async (mode) => {
    const host = await start('guest')
    const user = {
      type: 'user',
      sessionId,
      promptId,
      uuid: 'user',
      parentUuid: null,
      isSidechain: false,
      message: { content: 'Finish' }
    }
    const assistant = {
      type: 'assistant',
      sessionId,
      uuid: 'answer',
      parentUuid: 'user',
      isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Usage limit reached' }] }
    }
    writeFileSync(host.path, jsonl(user, assistant))
    await host.post('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: promptId,
      prompt: 'Finish'
    })
    await host.post('claude', {
      hook_event_name: 'PostToolUse',
      prompt_id: promptId,
      tool_name: 'Bash',
      tool_response: 'Usage limit reached'
    })
    await host.post('claude', {
      hook_event_name: 'StopFailure',
      prompt_id: promptId,
      error: 'rate_limit'
    })
    const failed = host.read()!
    expect('payload' in failed && failed.payload.lastAssistantMessage).toBe('Usage limit reached')
    const quota = {
      ...assistant,
      uuid: 'quota',
      parentUuid: 'answer',
      apiError: 'usage_limit_reached',
      error: 'rate_limit'
    }
    if (mode !== 'new-session') {
      appendFileSync(host.path, jsonl(quota))
    }
    if (mode === 'new-meta-root') {
      appendFileSync(
        host.path,
        jsonl({ ...user, uuid: 'meta', promptId: undefined, isMeta: true, parentUuid: 'quota' })
      )
    }
    if (mode === 'new-session') {
      await host.post('claude', {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: '55555555-5555-4555-8555-555555555555'
      })
    }
    if (mode === 'new-session') {
      appendFileSync(host.path, jsonl(quota))
    }
    if (mode === 'refine') {
      await vi.advanceTimersByTimeAsync(300)
      const refined = host.read()!
      expect('payload' in refined && refined.payload.mainAgent?.usageLimit).toEqual({})
      expect(host.read()?.turnEndedAt).toBe(failed.turnEndedAt)
      const request = { paneKey, sessionId, turnEndedAt: failed.turnEndedAt, source: 'claude' }
      expect(host.validate(request)).toEqual({ status: 'current' })
      expect(host.validate({ ...request, launchToken: 'different-owner' })).toEqual({
        status: 'changed'
      })
      appendFileSync(
        host.path,
        jsonl({
          ...user,
          uuid: 'next-native-input',
          promptId: undefined,
          isMeta: true,
          parentUuid: 'quota'
        })
      )
      expect(host.validate(request)).toEqual({ status: 'changed' })
    } else {
      await vi.advanceTimersByTimeAsync(300)
      const row = host.read()!
      expect('payload' in row && row.payload.mainAgent?.usageLimit).toBeUndefined()
    }
  }
)

it.each(['local', 'guest'] as const)(
  '%s preserves a failed root end while a child holds the visible turn working',
  async (kind) => {
    const host = await start(kind)
    const child = '019fa65f-3144-7151-9c02-cff7a28f316f'
    const childPath = join(host.path, '..', `rollout-child-${child}.jsonl`)
    writeFileSync(host.path, jsonl(event({ type: 'task_started', turn_id: 'root' })))
    writeFileSync(childPath, jsonl(event({ type: 'task_started', turn_id: 'child-turn' })))
    await host.post('codex', {
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'root',
      prompt: 'Finish'
    })
    appendFileSync(
      host.path,
      jsonl(
        event({
          type: 'sub_agent_activity',
          agent_thread_id: child,
          agent_path: '/root/child',
          kind: 'started',
          occurred_at_ms: 1_793_751_000_000
        })
      )
    )
    await host.post('codex', {
      hook_event_name: 'PostToolUse',
      turn_id: 'root',
      tool_name: 'spawn_agent'
    })
    appendFileSync(
      host.path,
      jsonl(
        event({
          type: 'task_complete',
          turn_id: 'root',
          error: { codex_error_info: 'usage_limit_exceeded' }
        })
      )
    )
    await vi.advanceTimersByTimeAsync(1000)
    const held = host.read()!
    const heldPayload = 'payload' in held ? held.payload : held
    expect(heldPayload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'failure', usageLimit: {} }
    })
    expect(held.turnEndedAt).toBeUndefined()
    expect(held.turnEndDisposition).toBeUndefined()
    await host.post('codex', { hook_event_name: 'Stop', turn_id: 'root' })
    expect(host.read()?.turnEndedAt).toBeUndefined()
    appendFileSync(childPath, jsonl(event({ type: 'task_complete', turn_id: 'child-turn' })))
    await vi.advanceTimersByTimeAsync(1000)
    const ended = host.read()!
    expect('payload' in ended ? ended.payload.state : ended.state).toBe('done')
    expect(ended.turnEndedAt).toBe(1_793_751_001_000)
    expect(ended.turnEndDisposition).toBe('identified')
    expect(host.local.getStatusSnapshotForPane(paneKey)[0]?.turnEndedAt).toBe(ended.turnEndedAt)
    if (kind === 'guest') {
      expect(
        host.validate({ paneKey, sessionId, turnEndedAt: ended.turnEndedAt, source: 'codex' })
      ).toEqual({ status: 'current' })
    }
    await host.post('codex', { hook_event_name: 'Stop', turn_id: 'root' })
    expect(host.read()?.turnEndedAt).toBe(ended.turnEndedAt)
    appendFileSync(host.path, jsonl(event({ type: 'task_started', turn_id: 'new-root' })))
    await host.post('codex', {
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'new-root',
      prompt: 'Finish'
    })
    await host.post('codex', { hook_event_name: 'Stop', turn_id: 'root' })
    const current = host.read()!
    expect('payload' in current ? current.payload.mainAgent?.state : current.mainAgent?.state).toBe(
      'working'
    )
    expect(current.turnEndedAt).toBeUndefined()
    if (kind === 'guest') {
      expect(
        host.validate({ paneKey, sessionId, turnEndedAt: ended.turnEndedAt, source: 'codex' })
      ).toEqual({ status: 'changed' })
    }
  }
)

it.each([
  ['local', 'before-release'],
  ['guest', 'before-release'],
  ['local', 'after-release'],
  ['guest', 'after-release']
] as const)('%s refines held Claude quota %s without replaying its end', async (kind, timing) => {
  const host = await start(kind)
  const user = {
    type: 'user',
    sessionId,
    promptId,
    uuid: 'user',
    parentUuid: null,
    isSidechain: false,
    message: { content: 'Finish' }
  }
  const answer = {
    type: 'assistant',
    sessionId,
    uuid: 'answer',
    parentUuid: 'user',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Usage limit reached' }] }
  }
  writeFileSync(host.path, jsonl(user, answer))
  await host.post('claude', {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: promptId,
    prompt: 'Finish'
  })
  await host.post('claude', { hook_event_name: 'SubagentStart', agent_id: 'areviewer-1' })
  await host.post('claude', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: 'Usage limit reached'
  })
  await vi.advanceTimersByTimeAsync(10)
  await host.post('claude', {
    hook_event_name: 'StopFailure',
    prompt_id: promptId,
    error: 'rate_limit'
  })
  expect(host.read()?.turnEndedAt).toBeUndefined()
  // Progress from a child has no StopFailure label but must not cancel the root's bounded flush retry.
  await host.post('claude', {
    hook_event_name: 'PreToolUse',
    agent_id: 'areviewer-1',
    tool_name: 'Bash'
  })
  if (timing === 'after-release') {
    await host.post('claude', { hook_event_name: 'SubagentStop', agent_id: 'areviewer-1' })
    expect(host.read()?.turnEndedAt).toBe(1_793_751_000_010)
  }
  appendFileSync(
    host.path,
    jsonl({
      ...answer,
      uuid: 'quota',
      parentUuid: 'answer',
      apiError: 'usage_limit_reached',
      error: 'rate_limit'
    })
  )
  await vi.advanceTimersByTimeAsync(100)
  const refined = host.read()!
  expect(
    'payload' in refined ? refined.payload.mainAgent?.usageLimit : refined.mainAgent?.usageLimit
  ).toEqual({})
  if (timing === 'before-release') {
    expect(refined.turnEndedAt).toBeUndefined()
    if (kind === 'guest') {
      host.replay()
      expect(host.read()?.turnEndedAt).toBeUndefined()
    }
    await host.post('claude', { hook_event_name: 'SubagentStop', agent_id: 'areviewer-1' })
  }
  expect(host.read()?.turnEndedAt).toBe(1_793_751_000_010)
  expect(host.read()?.turnEndDisposition).toBe('identified')
  expect(host.local.getStatusSnapshotForPane(paneKey)[0]?.mainAgent?.usageLimit).toEqual({})
  if (kind === 'local') {
    expect(
      host.local.prepareTerminalUsageLimitContinuation(paneKey, {
        sessionId,
        turnEndedAt: 1_793_751_000_010
      })?.()
    ).toBe(true)
  }
  if (kind === 'guest') {
    expect(
      host.validate({ paneKey, sessionId, turnEndedAt: 1_793_751_000_010, source: 'claude' })
    ).toEqual({ status: 'current' })
    host.replay()
    expect(host.read()?.turnEndedAt).toBe(1_793_751_000_010)
  }
})

it.each(['ambiguous', 'cancelled', 'new-root', 'session-restart'] as const)(
  'guest child release never promotes a %s Claude root end',
  async (mode) => {
    const host = await start('guest')
    await host.post('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: promptId,
      prompt: 'Finish'
    })
    await host.post('claude', { hook_event_name: 'SubagentStart', agent_id: 'areviewer-1' })
    await host.post('claude', {
      hook_event_name: 'StopFailure',
      prompt_id: promptId,
      error: 'rate_limit'
    })
    if (mode === 'ambiguous' || mode === 'cancelled') {
      await host.post('claude', {
        hook_event_name: 'Stop',
        prompt_id: promptId,
        ...(mode === 'cancelled' ? { is_interrupt: true } : {})
      })
    } else if (mode === 'new-root') {
      await host.post('claude', {
        hook_event_name: 'UserPromptSubmit',
        prompt_id: '33333333-3333-4333-8333-333333333333',
        prompt: 'Finish'
      })
    } else {
      await host.post('claude', { hook_event_name: 'SessionStart', source: 'startup' })
    }
    await host.post('claude', { hook_event_name: 'SubagentStop', agent_id: 'areviewer-1' })
    const ended = host.read()!
    expect(ended.turnEndDisposition).not.toBe('identified')
    if (mode === 'ambiguous') {
      expect(ended.turnEndDisposition).toBe('ambiguous')
      expect(ended.turnEndedAt).toBe(1_793_751_000_000)
    } else {
      expect(ended.turnEndedAt).toBeUndefined()
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(host.read()?.turnEndDisposition).not.toBe('identified')
    expect(
      host.validate({ paneKey, sessionId, turnEndedAt: 1_793_751_000_000, source: 'claude' })
    ).toEqual({ status: 'changed' })
  }
)

it('imports the first Codex quota on Stop and on child attribution without a healing poll', async () => {
  const host = await start('guest')
  const ptyId = 'quota-first-source-pty'
  rememberPaneKeyForPty(ptyId, paneKey)
  cleanups.push(() => {
    ptyPaneKey.delete(ptyId)
    paneKeyPtyId.delete(paneKey)
  })
  const started = (turn: string) => event({ type: 'task_started', turn_id: turn })
  const failed = (turn: string) =>
    event({
      type: 'task_complete',
      turn_id: turn,
      error: { codex_error_info: 'usage_limit_exceeded' }
    })
  writeFileSync(host.path, jsonl(started('first')))
  await host.post('codex', {
    hook_event_name: 'UserPromptSubmit',
    turn_id: 'first',
    prompt: 'Finish'
  })
  appendFileSync(host.path, jsonl(failed('first')))
  await host.post('codex', { hook_event_name: 'Stop', turn_id: 'first' })
  const first = host.local.getStatusSnapshotForPane(paneKey)[0]
  expect(first.mainAgent).toMatchObject({ state: 'done', outcome: 'failure', usageLimit: {} })
  const firstCut = { sessionId, turnEndedAt: first.turnEndedAt! }
  const prepared = host.local.prepareTerminalUsageLimitSource(paneKey, ptyId, firstCut)!
  cleanups.push(() => prepared.dispose())
  expect(prepared.isCurrent()).toBe(true)
  expect(host.validate(prepared.remote!.request)).toEqual({ status: 'current' })
  host.replay()
  expect(prepared.isCurrent()).toBe(true)

  appendFileSync(host.path, jsonl(started('second')))
  await host.post('codex', {
    hook_event_name: 'UserPromptSubmit',
    turn_id: 'second',
    prompt: 'Next'
  })
  expect(prepared.isCurrent()).toBe(false)
  await host.post('codex', { hook_event_name: 'Stop', turn_id: 'second' })
  const before = host.local.getStatusSnapshotForPane(paneKey)[0]
  expect(before.mainAgent?.usageLimit).toBeUndefined()
  appendFileSync(host.path, jsonl(failed('second')))
  await host.post('codex', { hook_event_name: 'SubagentStart', agent_id: 'child' })
  expect(host.local.getStatusSnapshotForPane(paneKey)[0]).toMatchObject({
    state: 'working',
    mainAgent: { state: 'done', outcome: 'failure', usageLimit: {} }
  })
  await host.post('codex', { hook_event_name: 'SubagentStop', agent_id: 'child' })
  const ended = host.local.getStatusSnapshotForPane(paneKey)[0]
  expect(ended).toMatchObject({
    state: 'done',
    turnEndedAt: before.turnEndedAt,
    mainAgent: { state: 'done', outcome: 'failure', usageLimit: {} }
  })
  const childCut = host.local.prepareTerminalUsageLimitSource(paneKey, ptyId, {
    sessionId,
    turnEndedAt: ended.turnEndedAt!
  })!
  cleanups.push(() => childCut.dispose())
  expect(childCut.isCurrent()).toBe(true)
  expect(host.validate(childCut.remote!.request)).toEqual({ status: 'current' })
})

it.each(['local', 'guest'] as const)(
  '%s compact cancels a pending failed cut before typed flush',
  async (kind) => {
    const host = await start(kind)
    const user = {
      type: 'user',
      sessionId,
      promptId,
      uuid: 'user',
      parentUuid: null,
      isSidechain: false,
      message: { content: 'Finish' }
    }
    writeFileSync(host.path, jsonl(user))
    await host.post('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: promptId,
      prompt: 'Finish'
    })
    await host.post('claude', { hook_event_name: 'SubagentStart', agent_id: 'areviewer-1' })
    await host.post('claude', {
      hook_event_name: 'StopFailure',
      prompt_id: promptId,
      error: 'rate_limit'
    })
    const completed = host.sourceRow()?.hostTurn?.completed
    expect(completed).toBeDefined()
    await host.post('claude', { hook_event_name: 'SessionStart', source: 'compact' })
    expect(host.sourceRow()?.hostTurn).toMatchObject({ currentTurnKey: 'seed', completed })
    expect(host.local.getStatusSnapshotForPane(paneKey)[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'failure' }
    })
    await host.post('claude', { hook_event_name: 'SubagentStop', agent_id: 'areviewer-1' })
    appendFileSync(
      host.path,
      jsonl({
        type: 'assistant',
        sessionId,
        uuid: 'quota',
        parentUuid: 'user',
        isSidechain: false,
        apiError: 'usage_limit_reached',
        error: 'rate_limit'
      })
    )
    await vi.advanceTimersByTimeAsync(300)
    const retired = host.local.getStatusSnapshotForPane(paneKey)[0]
    expect(retired.mainAgent?.usageLimit).toBeUndefined()
    expect(retired.turnEndedAt).toBeUndefined()
    expect(host.sourceRow()?.hostTurn).toMatchObject({ currentTurnKey: 'seed', completed })
    expect(
      host.local.prepareTerminalUsageLimitContinuation(paneKey, {
        sessionId,
        turnEndedAt: completed!.endedAt
      })
    ).toBeNull()
    if (kind === 'guest') {
      expect(
        host.validate({ paneKey, sessionId, turnEndedAt: completed!.endedAt, source: 'claude' })
      ).toEqual({ status: 'changed' })
    }
    await host.post('claude', { hook_event_name: 'Stop', prompt_id: promptId })
    if (kind === 'guest') {
      host.replay()
    }
    expect(host.local.getStatusSnapshotForPane(paneKey)[0]?.turnEndedAt).toBeUndefined()

    appendFileSync(
      host.path,
      jsonl({ ...user, uuid: 'next-user', promptId: '33333333-3333-4333-8333-333333333333' })
    )
    await host.post('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: '33333333-3333-4333-8333-333333333333',
      prompt: 'Next'
    })
    const opened = host.sourceRow()?.hostTurn?.currentTurnKey
    await host.post('claude', { hook_event_name: 'SessionStart', source: 'compact' })
    expect(host.sourceRow()?.hostTurn?.currentTurnKey).toBe(opened)
    expect(host.local.getStatusSnapshotForPane(paneKey)[0]?.mainAgent?.state).toBe('working')
    await host.post('claude', { hook_event_name: 'Stop' })
    expect(host.local.getStatusSnapshotForPane(paneKey)[0]?.turnEndDisposition).toBe('identified')
  }
)

it('never promotes a child-only Claude quota into a root action', async () => {
  const host = await start('local')
  writeFileSync(
    host.path,
    jsonl(
      { type: 'user', sessionId, promptId, uuid: 'user', parentUuid: null, isSidechain: false },
      {
        type: 'assistant',
        sessionId,
        uuid: 'child-quota',
        parentUuid: 'user',
        isSidechain: true,
        apiError: 'usage_limit_reached',
        error: 'rate_limit'
      }
    )
  )
  await host.post('claude', {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: promptId,
    prompt: 'Finish'
  })
  await host.post('claude', { hook_event_name: 'SubagentStart', agent_id: 'areviewer-1' })
  await host.post('claude', {
    hook_event_name: 'StopFailure',
    agent_id: 'areviewer-1',
    prompt_id: promptId,
    error: 'rate_limit'
  })
  const row = host.local.getStatusSnapshotForPane(paneKey)[0]
  expect(row.mainAgent?.state).toBe('working')
  expect(row.mainAgent?.usageLimit).toBeUndefined()
  expect(row.turnEndedAt).toBeUndefined()
})
