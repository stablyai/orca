import { mkdtemp, writeFile, appendFile, mkdir, rm, rename, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, seedLegacyAgentStatusForTests } from '../listener-state'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { ClaudeTranscriptDecoder } from './claude-transcript-decoder'
import { ClaudeHelperKillPoller } from './claude-helper-kill-poller'
import { readClaudeTranscriptChunk } from './claude-transcript-cursor'
import type { ClaudeLaunchedBackgroundTasks } from '../../claude-owed-task-notifications'
import type { AgentHookEventPayload } from '../listener-event'

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
  it('preserves a newer complete oversized prompt through scheduled settlement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const p = await pane(true)
    const paneKey = p.row().paneKey
    const due = vi.spyOn(p.poller, 'poll')
    const tasks: ClaudeLaunchedBackgroundTasks = new Map()
    const resumed = (text: string) =>
      `${JSON.stringify({
        type: 'user',
        timestamp: stamp(20),
        message: { content: [{ type: 'text', text }] }
      })}\n`
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
    try {
      const oversized = resumed('x'.repeat(262145))
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(256 * 1024)
      expect(Buffer.byteLength(prompt(-10) + oversized)).toBeLessThan(1024 * 1024)
      await appendFile(p.path, kill())
      await appendFile(p.child('a123'), oversized)
      await writeFile(p.child('acomplete'), resumed('Resume the work'))
      vi.setSystemTime(now + 25)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'acomplete' }))
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      p.replace(
        p.post({
          hook_event_name: 'PermissionRequest',
          agent_id: 'a123',
          tool_name: 'Bash',
          tool_use_id: 'oversized-approval',
          tool_input: { command: 'false' }
        })
      )
      tasks.set('a123', { kind: 'agent', notificationOwedAt: now })
      tasks.set('shell', { kind: 'shell', notificationOwedAt: now })
      p.state.claudeLaunchedBackgroundTasksByPaneKey.set(paneKey, tasks)
      expect(preservation()).toEqual(expected)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(due).toHaveBeenCalled()
      await Promise.all(
        due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
      )
      const observed = {
        ...preservation(),
        control: p.row().payload.subagents?.find((child) => child.id === 'acomplete')?.state,
        shellDebt: tasks.get('shell'),
        timers: vi.getTimerCount()
      }
      process.stdout.write(`C9 complete oversized prompt ${JSON.stringify(observed)}\n`)
      expect(observed.control).toBe('working')
      expect(observed.shellDebt).toEqual({ kind: 'shell', notificationOwedAt: now })
      expect(preservation()).toEqual(expected)
      await appendFile(p.path, kill(30))
      await vi.advanceTimersByTimeAsync(5_000)
      await Promise.all(
        due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
      )
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.state.claudeLeadStateByPaneKey.get(paneKey)?.waitingAgentId).toBeUndefined()
      expect(tasks.get('a123')?.settled).toBe(true)
      expect(tasks.get('shell')).toEqual({ kind: 'shell', notificationOwedAt: now })
      expect(p.row().payload.workingMode).toBe('monitoring')
      expect(p.row().payload.lastAssistantMessage).toBe('READY')
      expect(p.publish).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      p.poller.clearAll()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    }
  })

  it.each(['first child', 'later child', 'parent resume'])(
    'decodes large %s evidence without future writer assistance',
    async (scenario) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        for (const size of [300_000, 2 * 1024 * 1024 + 100]) {
          const p = await pane(true)
          const at = scenario === 'first child' ? -10 : 20
          const large = 'é'.repeat(Math.ceil(size / 2))
          const key = p.row().paneKey
          try {
            await appendFile(
              p.path,
              `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(1), ignored: large })}\n`
            )
            if (scenario === 'parent resume' || scenario === 'first child') {
              await appendFile(
                p.path,
                `${JSON.stringify({ type: 'assistant', timestamp: stamp(at), message: { content: [{ type: 'tool_use', id: 'resume', name: 'Agent', input: { prompt: large } }] } })}\n${JSON.stringify({ type: 'user', toolUseResult: { isAsync: true, agentId: 'a123' }, message: { content: [{ type: 'tool_result', tool_use_id: 'resume', content: large }] } })}\n`
              )
            }
            if (scenario !== 'parent resume') {
              const line = `${JSON.stringify({ type: 'user', timestamp: stamp(at), message: { content: [{ type: 'text', text: large }] } })}\n`
              await (scenario === 'first child' ? writeFile : appendFile)(p.child('a123'), line)
            }
            // All finite input, including the ONLY eligible K, is present before first open.
            const rounds = Math.ceil((size * 4) / (1024 * 1024)) + 4
            for (let n = 0; n < rounds; n++) {
              await p.poller.poll(key)
            }
            const owner = p.poller['observations'].get(key)!
            expect(owner.launches.size).toBe(0)
            expect(owner.parent.offset).toBe(Buffer.byteLength(await readFile(p.path)))
            if (scenario === 'first child') {
              expect(p.row().payload.subagents ?? []).toEqual([])
              expect(p.publish).toHaveBeenCalledTimes(1)
            } else {
              expect(p.row().payload.subagents?.[0]?.state).toBe('working')
              expect(p.publish).not.toHaveBeenCalled()
              if (scenario === 'parent resume') {
                expect(owner.resumedAt.get('a123')).toBe(now + 20)
              }
              await appendFile(p.path, kill(30))
              await p.poller.poll(key)
              expect(p.row().payload.subagents ?? []).toEqual([])
              expect(p.publish).toHaveBeenCalledTimes(1)
            }
            expect(p.row().payload.workingMode).toBe('monitoring')
            expect(p.row().payload.lastAssistantMessage).toBe('READY')
            expect(vi.getTimerCount()).toBe(0)
          } finally {
            p.poller.clearAll()
          }
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

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
        message: { content: [{ type: 'text', text: 'Resume the work'.repeat(30_000) }] }
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
        // Byte progress validates a malformed frame; no LF means no complete evidence frontier.
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
          expect(cursor.decoder.unfinished).toBe(true)
          expect(cursor.decoder['head'].length).toBeLessThanOrEqual(320)
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
    const reader: typeof readClaudeTranscriptChunk = async (cursor, limit, consumer) => {
      if (first) {
        first = false
        await gate
      }
      return readClaudeTranscriptChunk(cursor, limit, consumer)
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
    const reader: typeof readClaudeTranscriptChunk = async (cursor, limit, consumer) => {
      const before = cursor.offset
      const chunk = await readClaudeTranscriptChunk(
        cursor,
        limit,
        consumer && {
          ...consumer,
          consume: async (record) => {
            records++
            await consumer.consume(record)
          }
        }
      )
      calls++
      bytes += cursor.offset - before
      records += chunk?.records.length ?? 0
      expect(cursor.decoder['head'].length).toBeLessThanOrEqual(320)
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

it('advances finite N/10N payload, depth, scalar and fact work with bounded batches and ordered yielding', async () => {
  const measurements: {
    N: number
    bytes: number
    calls: number
    tokens: number
    batches: number
    maxBatch: number
    retained: number
    selected: number
    facts: number
    depth: number
    applications: number
    scalarParts: number
    childStorage: number
    staging: number
  }[] = []
  for (const N of [10, 100]) {
    let scalarParts = 0,
      childStorage = 0,
      staging = 0,
      readingChild = false
    let tokens = 0,
      batches = 0,
      maxBatch = 0,
      retained = 0,
      depth = 0
    const write = ClaudeTranscriptDecoder.prototype.write
    const observe = vi
      .spyOn(ClaudeTranscriptDecoder.prototype, 'write')
      .mockImplementation(function (this: ClaudeTranscriptDecoder, text) {
        const before = this['tokens']
        write.call(this, text)
        tokens += this['tokens'] - before
        batches++
        maxBatch = Math.max(maxBatch, text.length)
        retained = Math.max(retained, this['head'].length)
        depth = Math.max(depth, this['stack'].length)
        const parts = this['parts'].reduce((sum, part) => sum + part.length, 0)
        scalarParts = Math.max(scalarParts, parts)
        const storage = JSON.stringify([this['stack'], this['value'], this['head']]).length + parts
        staging = Math.max(staging, storage)
        if (readingChild) {
          childStorage = Math.max(childStorage, storage)
        }
      })
    let bytes = 0,
      calls = 0
    const reader: typeof readClaudeTranscriptChunk = async (cursor, limit, consumer) => {
      const before = cursor.offset
      readingChild = cursor.path.includes('subagents')
      const result = await readClaudeTranscriptChunk(cursor, limit, consumer)
      readingChild = false
      const consumed = cursor.offset - before
      expect(consumed).toBeLessThanOrEqual(1024 * 1024)
      bytes += consumed
      calls++
      return result
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = await pane(true, reader)
    try {
      const owner = p.poller['observations'].get(p.row().paneKey)!
      const id = 'fixed-id'
      const factCount = N * 52
      const invocations = Array.from({ length: factCount }, (_, i) => ({
        type: 'tool_use',
        name: 'Agent',
        id: `${id}-${i}`
      }))
      const outcomes = invocations.map((item) => ({ type: 'tool_result', tool_use_id: item.id }))
      const prefix = `${JSON.stringify({ type: 'assistant', timestamp: stamp(-10), message: { content: invocations } })}\n`
      const suffix = `${JSON.stringify({ type: 'user', toolUseResult: { isAsync: true, agentId: 'a123' }, message: { content: outcomes } })}\n`
      const nested = `{"ignored":${'['.repeat(N)}"${'x'.repeat(80_000)}"${']'.repeat(N)}}\n`
      const longId = 's'.repeat(N * 10_000)
      const scalar = `${JSON.stringify({ type: 'assistant', timestamp: stamp(-10), message: { content: [{ type: 'tool_use', name: 'Task', id: longId }] } })}\n${JSON.stringify({ type: 'user', toolUseResult: { isAsync: true, agentId: 'a123' }, message: { content: [{ type: 'tool_result', tool_use_id: longId }] } })}\n`
      await appendFile(
        p.path,
        `${kill()}${prefix}${suffix}${nested}${scalar}${prompt(-10).repeat(N)}`
      )
      const large = `${JSON.stringify({ type: 'user', timestamp: stamp(-10), message: { content: [{ type: 'text', text: 'x'.repeat(N * 115_000) }] } })}\n`
      await writeFile(p.child('a123'), large)
      const total = Buffer.byteLength(await readFile(p.path)) + Buffer.byteLength(large)
      let applications = 0
      let checkpoints = 0
      const set = owner.launches.set.bind(owner.launches)
      vi.spyOn(owner.launches, 'set').mockImplementation((key, value) => {
        applications++
        if (applications % 512 === 1) {
          const initial = applications
          queueMicrotask(() => {
            checkpoints++
            expect(applications - initial).toBeLessThan(512)
            expect(owner.pending).toBeDefined()
            expect(p.publish).not.toHaveBeenCalled()
            // The later result record/child cannot overtake unfinished launch application.
            expect(owner.parent.offset).toBe(Buffer.byteLength(prompt(-20) + kill() + prefix))
          })
        }
        return set(key, value)
      })
      for (let iteration = 0; iteration < Math.ceil(total / (1024 * 1024)) + 4; iteration++) {
        const pending = p.poller.poll(p.row().paneKey)
        expect(p.poller.poll(p.row().paneKey)).toBe(pending)
        await pending
      }
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.publish).toHaveBeenCalledTimes(1)
      expect(owner.launches.size).toBe(0)
      expect(owner.resumedAt.get('a123')).toBe(now - 10)
      expect(applications).toBe(factCount + 1)
      expect(checkpoints).toBe(Math.ceil(factCount / 512))
      expect(bytes).toBe(total)
      expect(maxBatch).toBeLessThanOrEqual(64 * 1024)
      expect(retained).toBeLessThanOrEqual(320)
      expect(depth).toBeGreaterThanOrEqual(N)
      expect(vi.getTimerCount()).toBe(0)
      const baseline = { bytes, tokens }
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await p.poller.poll(p.row().paneKey)
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect({ bytes, tokens }).toEqual(baseline)
      measurements.push({
        N,
        bytes,
        calls,
        tokens,
        batches,
        maxBatch,
        retained,
        selected: N * 10_000,
        facts: factCount,
        depth,
        applications,
        scalarParts,
        childStorage,
        staging
      })
    } finally {
      p.poller.clearAll()
      observe.mockRestore()
      vi.useRealTimers()
    }
  }
  expect(measurements[1].bytes).toBeGreaterThan(measurements[0].bytes * 9)
  expect(measurements[1].bytes).toBeLessThan(measurements[0].bytes * 11)
  expect(measurements[1].tokens).toBeGreaterThan(measurements[0].tokens * 9)
  expect(measurements[1].tokens).toBeLessThan(measurements[0].tokens * 13)
  expect(measurements[1].applications - 1).toBe((measurements[0].applications - 1) * 10)
  expect(measurements[1].scalarParts).toBeGreaterThan(measurements[0].scalarParts * 5)
  expect(measurements[1].childStorage).toBe(measurements[0].childStorage)
  expect(measurements[1].staging).toBeGreaterThan(measurements[0].staging * 5)
  process.stdout.write(`semantic decoder resource contract ${JSON.stringify(measurements)}\n`)
})
