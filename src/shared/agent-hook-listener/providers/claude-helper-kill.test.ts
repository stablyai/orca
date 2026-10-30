import { mkdtemp, writeFile, appendFile, mkdir, rm, rename, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, seedLegacyAgentStatusForTests } from '../listener-state'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { ClaudeHelperKillPoller } from './claude-helper-kill-poller'
import { createClaudeTranscriptCursor, readClaudeTranscriptChunk } from './claude-transcript-cursor'
import type { ClaudeLaunchedBackgroundTasks } from '../../claude-owed-task-notifications'
import type { AgentHookEventPayload } from '../listener-event'
import { readClaudeHelperEvidence } from './claude-helper-transcript-evidence'

let dir: string
const now = Date.parse('2026-10-29T12:00:00Z')
const stamp = (offset: number) => new Date(now + offset).toISOString()
const kill = (offset = 1) =>
  `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(offset) })}\n`
const prompt = (offset: number) =>
  `${JSON.stringify({
    type: 'user',
    timestamp: stamp(offset),
    message: { role: 'user', content: 'Do the work' }
  })}\n`

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  dir = await mkdtemp(join(tmpdir(), 'claude-helper-kill-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function pane(shell = false, reader = readClaudeTranscriptChunk, cron = false) {
  const state = createHookListenerState()
  const path = join(dir, 'session.jsonl')
  await writeFile(path, prompt(-20))
  await mkdir(join(dir, 'session', 'subagents'), { recursive: true })
  const child = (id: string) => join(dir, 'session', 'subagents', `agent-${id}.jsonl`)
  await writeFile(child('a123'), prompt(-10))
  let current: AgentHookEventPayload | undefined
  const events: AgentHookEventPayload[] = []
  function post(payload: Record<string, unknown>) {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'test-tab:11111111-1111-4111-8111-111111111111',
        env: 'production',
        payload: { session_id: 'session', transcript_path: path, ...payload }
      },
      'production'
    )
    if (!event) {
      throw new Error('hook declined')
    }
    current = event
    seedLegacyAgentStatusForTests(state, event)
    return event
  }
  post({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
  post({ hook_event_name: 'SubagentStart', agent_id: 'a123' })
  post({
    hook_event_name: 'Stop',
    last_assistant_message: 'READY',
    background_tasks: [
      { id: 'a123', type: 'subagent', status: 'running' },
      ...(shell ? [{ id: 'shell', type: 'local_bash', status: 'running' }] : [])
    ],
    session_crons: cron ? [{ id: 'cron' }] : []
  })
  const publish = vi.fn((event: AgentHookEventPayload) => {
    current = event
    events.push(event)
    seedLegacyAgentStatusForTests(state, event)
  })
  const poller = new ClaudeHelperKillPoller(
    state,
    { current: () => current, publish, listening: () => true },
    reader
  )
  poller.schedule(current!)
  return {
    state,
    path,
    child,
    post,
    poller,
    publish,
    events,
    row: () => current!,
    replace: (row: AgentHookEventPayload) => {
      current = row
      poller.schedule(row)
    }
  }
}

async function drain(p: Awaited<ReturnType<typeof pane>>) {
  for (let i = 0; i < 8; i++) {
    await p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
  }
}

describe('Claude helper provider evidence', () => {
  it.each(['parent', 'child'])(
    'preserves generations until %s framing completes through scheduled probes',
    async (stream) => {
      vi.useFakeTimers()
      vi.setSystemTime(now)
      const p = await pane(true)
      const paneKey = p.row().paneKey
      const due = vi.spyOn(p.poller, 'poll')
      const tasks: ClaudeLaunchedBackgroundTasks = new Map()
      const resumed = JSON.stringify({
        type: 'user',
        timestamp: stamp(20),
        message: { content: [{ type: 'text', text: 'Resume the work' }] }
      })
      const preservation = () => ({
        child: p.row().payload.subagents?.find((child) => child.id === 'a123')?.state ?? null,
        waitOwner: p.state.claudeLeadStateByPaneKey.get(paneKey)?.waitingAgentId ?? null,
        debt: { ...tasks.get('a123') },
        endings: p.publish.mock.calls.length
      })
      const expected = {
        child: 'working',
        waitOwner: 'a123',
        debt: { kind: 'agent', notificationOwedAt: now },
        endings: 0
      }
      const probe = async (delay: number) => {
        const before = due.mock.calls.length
        await vi.advanceTimersByTimeAsync(delay)
        expect(due.mock.calls.length).toBeGreaterThan(before)
        await Promise.all(
          due.mock.results
            .slice(before)
            .map((result) => (result.type === 'return' ? result.value : undefined))
        )
      }
      try {
        await appendFile(p.path, kill())
        await appendFile(p.child('a123'), stream === 'child' ? resumed : `${resumed}\n`)
        if (stream === 'parent') {
          await appendFile(p.path, resumed)
        }
        await writeFile(p.child('acomplete'), `${resumed}\n`)
        vi.setSystemTime(now + 25)
        p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'acomplete' }))
        p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
        p.replace(
          p.post({
            hook_event_name: 'PermissionRequest',
            agent_id: 'a123',
            tool_name: 'Bash',
            tool_use_id: 'partial-approval',
            tool_input: { command: 'false' }
          })
        )
        tasks.set('a123', { kind: 'agent', notificationOwedAt: now })
        tasks.set('shell', { kind: 'shell', notificationOwedAt: now })
        p.state.claudeLaunchedBackgroundTasksByPaneKey.set(paneKey, tasks)
        expect(preservation()).toEqual(expected)
        await probe(1_000)
        expect(p.row().payload.subagents?.find((child) => child.id === 'acomplete')?.state).toBe(
          'working'
        )
        expect(preservation()).toEqual(expected)
        await probe(5_000)
        expect(preservation()).toEqual(expected)

        await appendFile(stream === 'child' ? p.child('a123') : p.path, '\n')
        await probe(5_000)
        expect(preservation()).toEqual(expected)
        expect(p.row().payload.subagents?.find((child) => child.id === 'acomplete')?.state).toBe(
          'working'
        )

        const blockedPaths =
          stream === 'parent' ? [p.path] : [p.child('a123'), p.child('acomplete')]
        await appendFile(p.path, kill(30))
        for (const path of blockedPaths) {
          await appendFile(path, 'x'.repeat(1024 * 1024 + 10))
        }
        // Byte progress enters bounded discard mode; no LF means no complete evidence frontier.
        await probe(5_000)
        expect(preservation()).toEqual(expected)
        await probe(5_000)
        expect(preservation()).toEqual(expected)
        await probe(5_000)
        expect(preservation()).toEqual(expected)
        const owner = p.poller['observations'].get(paneKey)!
        const cursors =
          stream === 'parent' ? [owner.parent] : [...owner.children.values()].map((c) => c.cursor)
        for (const cursor of cursors) {
          expect(cursor.skipping).toBe(true)
          expect(cursor.carry.length).toBe(0)
        }
        expect(vi.getTimerCount()).toBe(1)
        for (const path of blockedPaths) {
          await appendFile(path, '\n')
        }
        await probe(5_000)
        expect(p.row().payload.subagents ?? []).toEqual([])
        expect(tasks.get('a123')).toEqual({
          kind: 'agent',
          notificationOwedAt: undefined,
          settled: true
        })
        expect(p.state.claudeLeadStateByPaneKey.get(paneKey)?.waitingAgentId).toBeUndefined()
        expect(tasks.get('shell')?.notificationOwedAt).toBe(now)
        expect(p.publish).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        p.poller.clearAll()
        vi.useRealTimers()
      }
    }
  )

  it('retains evidence across same-owner row replacement and a drained-helper gap', async () => {
    const p = await pane(false, readClaudeTranscriptChunk, true)
    const before = p.row()
    try {
      await appendFile(p.path, kill())
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.row().payload.state).toBe('working')
      expect(p.row().payload.workingMode).toBe('monitoring')
      expect(p.row().payload.mainAgent).toEqual(before.payload.mainAgent)
      expect(p.row().payload.lastAssistantMessage).toBe('READY')
      expect(p.row().hookEventName).toBe('SubagentStop')
      expect(p.row().toolAgentId).toBe('a123')
      expect(p.row().turnEndedAt).toBe(before.turnEndedAt)
      vi.mocked(Date.now).mockReturnValue(now + 5)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      p.replace(
        p.post({
          hook_event_name: 'Stop',
          background_tasks: [{ id: 'a123', type: 'subagent', status: 'running' }]
        })
      )
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      await appendFile(
        p.child('a123'),
        [
          { message: { content: '[Request interrupted by user]' } },
          { message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
          { isMeta: true, message: { content: 'Injected context' } },
          { isCompactSummary: true, message: { content: 'Summary' } },
          { message: { content: [{ type: 'tool_result' }, { type: 'text', text: 'tool result' }] } }
        ]
          .map((r) => `${JSON.stringify({ type: 'user', timestamp: stamp(10), ...r })}\n`)
          .join('')
      )
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      await appendFile(
        p.child('a123'),
        `${JSON.stringify({
          type: 'user',
          timestamp: stamp(20),
          message: { content: [{ type: 'text', text: 'Resume the work' }] }
        })}\n`
      )
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    } finally {
      p.poller.clearAll()
    }
  })

  it('uses an explicit provider resume rather than the teammates lifetime display clock', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      await drain(p)
      await writeFile(p.child('areviewer-123'), prompt(-10))
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'areviewer-123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('idle')
      await appendFile(
        p.path,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: stamp(10),
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'resume-tool',
                name: 'Agent',
                input: { resume: 'areviewer-123' }
              }
            ]
          }
        })}\n`
      )
      await appendFile(
        p.path,
        `${JSON.stringify({
          type: 'user',
          timestamp: stamp(15),
          toolUseResult: { isAsync: true, agentId: 'areviewer-123' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'resume-tool' }] }
        })}\n`
      )
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'areviewer-123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
      await appendFile(p.path, kill(30))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('idle')
    } finally {
      p.poller.clearAll()
    }
  })

  it('serializes deferred reads, retains its scheduler entry, and reconciles the latest same-owner hook', async () => {
    vi.useFakeTimers()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const reader: typeof readClaudeTranscriptChunk = async (cursor, limit) => {
      if (first) {
        first = false
        await gate
      }
      return readClaudeTranscriptChunk(cursor, limit)
    }
    const p = await pane(false, reader)
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      const pending = p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      expect(p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')).toBe(pending)
      await appendFile(p.path, kill())
      p.replace(p.post({ hook_event_name: 'PreToolUse', agent_id: 'a123', tool_name: 'Bash' }))
      release()
      await pending
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release()
      p.poller.clearAll()
      vi.useRealTimers()
    }
  })

  it('ends only killed agent notification debt without claiming delivery', async () => {
    const p = await pane()
    try {
      const tasks: ClaudeLaunchedBackgroundTasks = new Map([
        ['a123', { kind: 'agent' as const, notificationOwedAt: now }],
        ['shell', { kind: 'shell' as const, notificationOwedAt: now }]
      ])
      p.state.claudeLaunchedBackgroundTasksByPaneKey.set(
        'test-tab:11111111-1111-4111-8111-111111111111',
        tasks
      )
      await appendFile(p.path, kill())
      await drain(p)
      expect(tasks.get('a123')).toEqual({
        kind: 'agent',
        notificationOwedAt: undefined,
        settled: true
      })
      expect(tasks.get('shell')?.notificationOwedAt).toBe(now)
    } finally {
      p.poller.clearAll()
    }
  })

  it('ignores old/malformed records, then lets a fresh inventory settle the claim', async () => {
    const p = await pane()
    try {
      await appendFile(
        p.path,
        `${kill(-1)}{"type":"system","subtype":"agents_killed","timestamp":"bad"}\n`
      )
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
      p.replace(p.post({ hook_event_name: 'Stop', background_tasks: [] }))
      expect(p.row().payload.subagents ?? []).toEqual([])
    } finally {
      p.poller.clearAll()
    }
  })

  it('forgets kills on parent file replacement', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      await writeFile(join(dir, 'replacement.jsonl'), kill())
      await rename(join(dir, 'replacement.jsonl'), p.path)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    } finally {
      p.poller.clearAll()
    }
  })

  it('does not apply an in-flight read after pane retirement or to its successor', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      const reading = p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      p.poller.clear('test-tab:11111111-1111-4111-8111-111111111111')
      p.replace({
        ...p.row(),
        providerSession: { key: 'session_id', id: 'replacement', transcriptPath: p.path }
      })
      await reading
      expect(p.publish).not.toHaveBeenCalled()
    } finally {
      p.poller.clearAll()
    }
  })
})

describe('forward transcript reading', () => {
  it('carries a record split across chunks without dropping a prefix or UTF-8', async () => {
    const path = join(dir, 'split.jsonl')
    const line = `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(1), text: 'é' })}\n`
    await writeFile(path, line)
    const cursor = createClaudeTranscriptCursor(path)
    const records: Record<string, unknown>[] = []
    for (let i = 0; i < 50; i++) {
      const result = await readClaudeTranscriptChunk(cursor, 7)
      records.push(...(result?.records ?? []))
      if (result?.caughtUp) {
        break
      }
    }
    expect(records).toEqual([JSON.parse(line)])
  })

  it('skips one overlong line through its newline and retains the following kill', async () => {
    const path = join(dir, 'oversize.jsonl')
    await writeFile(path, `${'x'.repeat(1024 * 1024 + 10)}\n${kill()}`)
    const cursor = createClaudeTranscriptCursor(path)
    const first = await readClaudeTranscriptChunk(cursor)
    const next = await readClaudeTranscriptChunk(cursor)
    expect(first?.records).toEqual([])
    expect(next?.records).toHaveLength(1)
  })

  it('treats missing files as unverifiable and replacement/shrink as a new baseline', async () => {
    const path = join(dir, 'replace.jsonl')
    const cursor = createClaudeTranscriptCursor(path)
    expect(await readClaudeTranscriptChunk(cursor)).toBeUndefined()
    await writeFile(path, `${prompt(0)}${' '.repeat(200)}`)
    await readClaudeTranscriptChunk(cursor)
    await writeFile(path, kill())
    expect((await readClaudeTranscriptChunk(cursor))?.records).toEqual([])
    await appendFile(path, kill(20))
    expect((await readClaudeTranscriptChunk(cursor))?.records).toHaveLength(1)
  })
})

it('consumes every settled launch correlation at N and 10N without inventing failed resumes', () => {
  for (const count of [10, 100]) {
    const evidence = {
      observedAt: now,
      resumedAt: new Map<string, number>(),
      launches: new Map<string, number>()
    }
    for (let index = 0; index < count; index++) {
      for (const outcome of ['sync', 'failed', 'async', 'missing-time']) {
        const id = `${outcome}-${index}`
        readClaudeHelperEvidence(evidence, [
          {
            type: 'assistant',
            timestamp: stamp(index),
            message: { content: [{ type: 'tool_use', name: 'Agent', id }] }
          },
          {
            type: 'user',
            ...(outcome === 'missing-time' ? {} : { timestamp: stamp(index + 1) }),
            toolUseResult: { isAsync: outcome === 'async' || outcome === 'failed', agentId: id },
            message: {
              content: [{ type: 'tool_result', tool_use_id: id, is_error: outcome === 'failed' }]
            }
          }
        ])
      }
    }
    expect(evidence.launches.size).toBe(0)
    expect([...evidence.resumedAt.keys()]).toEqual(
      Array.from({ length: count }, (_, i) => `async-${i}`)
    )
  }
})

it('bounds real corpus reads at N and 10N, parks after settlement and delivers after a legitimate wake', async () => {
  const corpus = await readFile(
    new URL('../../__fixtures__/claude-helper-kill-2.1.310-parent.jsonl', import.meta.url),
    'utf8'
  )
  const results: { children: number; bytes: number; records: number; calls: number; ms: number }[] =
    []
  for (const count of [10, 100]) {
    let calls = 0,
      bytes = 0,
      records = 0
    const reader: typeof readClaudeTranscriptChunk = async (cursor) => {
      const before = cursor.offset
      const chunk = await readClaudeTranscriptChunk(cursor)
      calls++
      bytes += cursor.offset - before
      records += chunk?.records.length ?? 0
      expect(cursor.carry.length).toBeLessThanOrEqual(256 * 1024)
      return chunk
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = await pane(false, reader)
    const started = performance.now()
    try {
      // The only eligible first kill precedes >1MiB of old captured history and all async opens.
      await appendFile(p.path, `${kill()}${corpus.repeat(count * 10)}`)
      for (let i = 1; i < count; i++) {
        await writeFile(p.child(`a${i}`), prompt(-10))
        p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: `a${i}` }))
      }
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      // Keep one real resumed generation alive and one missing file unverifiable across safety probes.
      await appendFile(p.child('a123'), prompt(10))
      await rm(p.child('a1'))
      for (
        let i = 0;
        i < Math.ceil((Buffer.byteLength(corpus) * count * 10) / (1024 * 1024)) + 2;
        i++
      ) {
        await p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      }
      expect(
        p
          .row()
          .payload.subagents?.map((c) => c.id)
          .sort()
      ).toEqual(['a1', 'a123'])
      expect(p.publish).toHaveBeenCalledTimes(1)
      const baselineCalls = calls,
        baselineBytes = bytes
      await drain(p)
      expect(calls - baselineCalls).toBe(8 * 3)
      expect(bytes).toBe(baselineBytes)
      await writeFile(p.child('a1'), prompt(-10))
      await appendFile(p.path, kill(20))
      await p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.publish).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
      const published = p.publish.mock.calls.length
      const settledBytes = bytes
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.publish).toHaveBeenCalledTimes(published + 1)
      expect(bytes).toBe(settledBytes)
      results.push({ children: count, bytes, records, calls, ms: performance.now() - started })
      expect(calls).toBeLessThan(count * 2 + 50)
    } finally {
      p.poller.clearAll()
      vi.useRealTimers()
    }
  }
  expect(results[1]!.records).toBeLessThanOrEqual(results[0]!.records * 10)
  expect(results[1]!.bytes).toBeLessThanOrEqual(results[0]!.bytes * 10)
  process.stdout.write(`Claude helper corpus contract ${JSON.stringify(results)}\n`)
})
