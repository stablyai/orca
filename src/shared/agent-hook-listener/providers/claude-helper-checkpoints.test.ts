import { appendFile, writeFile, readFile, rename, open } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ClaudeTranscriptDecoder } from './claude-transcript-decoder'
import { readClaudeTranscriptChunk } from './claude-transcript-cursor'
import type { ClaudeLaunchedBackgroundTasks } from '../../claude-owed-task-notifications'
vi.mock('node:fs/promises', { spy: true })

import { dir, now, stamp, kill, prompt, pane } from './claude-helper-kill.test-fixture'

const actual = await vi.importActual<{ open: typeof open }>('node:fs/promises')

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
    retries: number
    prepared: number
    applied: number
    inputRetries: number
    newInputBytes: number
    retryInputBytes: number
    maxTokens: number
    maxFetched: number
    actualReadBytes: number
    opens: number
  }[] = []
  for (const N of [10, 100]) {
    const descriptors: Awaited<ReturnType<typeof open>>[] = []
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args)
      vi.spyOn(file, 'read')
      descriptors.push(file)
      return file
    })
    let scalarParts = 0,
      childStorage = 0,
      staging = 0,
      readingChild = false
    let tokens = 0,
      batches = 0,
      maxBatch = 0,
      retained = 0,
      depth = 0
    let inputRetries = 0,
      newInputBytes = 0,
      retryInputBytes = 0,
      maxTokens = 0,
      maxFetched = 0,
      childRejected = false
    const write = ClaudeTranscriptDecoder.prototype.write
    const observe = vi
      .spyOn(ClaudeTranscriptDecoder.prototype, 'write')
      .mockImplementation(function (this: ClaudeTranscriptDecoder, text, input) {
        const before = this['tokens']
        if (input?.tokens) {
          retryInputBytes += Buffer.byteLength(text)
        } else {
          newInputBytes += Buffer.byteLength(text)
        }
        write.call(this, text, input)
        tokens += this['tokens'] - before
        maxTokens = Math.max(maxTokens, input?.tokens?.length ?? 0)
        if (readingChild && !childRejected) {
          childRejected = true
          inputRetries++
          throw new RangeError('accepted child input')
        }
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
      try {
        return await readClaudeTranscriptChunk(cursor, limit, consumer)
      } finally {
        readingChild = false
        const consumed = cursor.offset - before
        expect(consumed).toBeLessThanOrEqual(1024 * 1024)
        bytes += consumed
        calls++
        maxFetched = Math.max(maxFetched, cursor.input?.bytes.length ?? 0)
      }
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
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
      let beforeFault = false,
        afterFault = false,
        resultFault = false,
        retries = 0,
        applied = 0
      const prepared = new Set<() => void>()
      const set = owner.launches.set.bind(owner.launches)
      vi.spyOn(owner.launches, 'set').mockImplementation((key, value) => {
        prepared.add(owner.parent.record!.application.operation!)
        applications++
        if (key === 'fixed-id-255' && !beforeFault) {
          beforeFault = true
          retries++
          throw new RangeError('before launch')
        }
        if (key === 'fixed-id-383' && !afterFault) {
          set(key, value)
          applied++
          afterFault = true
          retries++
          throw new RangeError('after launch')
        }
        applied++
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
      const resume = owner.resumedAt.set.bind(owner.resumedAt)
      vi.spyOn(owner.resumedAt, 'set').mockImplementation((id, value) => {
        if (!resultFault) {
          resultFault = true
          retries++
          expect(owner.launches.has('fixed-id-0')).toBe(false)
          throw new RangeError('consumed correlation')
        }
        return resume(id, value)
      })
      const due = vi.spyOn(p.poller, 'poll')
      for (let iteration = 0; iteration < Math.ceil(total / (1024 * 1024)) + 8; iteration++) {
        const pending = p.poller.poll(p.row().paneKey)
        expect(p.poller.poll(p.row().paneKey)).toBe(pending)
        try {
          await pending
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError)
          const initial = due.mock.calls.length
          await vi.advanceTimersByTimeAsync(5_000)
          expect(due.mock.calls.length).toBeGreaterThan(initial)
          await Promise.all(
            due.mock.results.slice(initial).map((result) =>
              result.type === 'return'
                ? result.value.catch((failure: unknown) => {
                    expect(failure).toBeInstanceOf(RangeError)
                  })
                : undefined
            )
          )
        }
      }
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.publish).toHaveBeenCalledTimes(1)
      expect(owner.launches.size).toBe(0)
      expect(owner.resumedAt.get('a123')).toBe(now - 10)
      expect(applications).toBe(factCount + 3)
      expect(prepared.size).toBe(factCount + 1)
      expect(applied).toBe(factCount + 2)
      expect(retries).toBe(3)
      expect(inputRetries).toBe(1)
      expect(retryInputBytes).toBeLessThanOrEqual(64 * 1024)
      expect(newInputBytes).toBeLessThanOrEqual(total)
      expect(newInputBytes).toBeGreaterThan(total - N - 20)
      expect(maxTokens).toBeLessThanOrEqual(3 * 64 * 1024)
      expect(maxFetched).toBeLessThanOrEqual(1024 * 1024)
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
      const reads = await Promise.all(
        descriptors.flatMap((file) =>
          vi
            .mocked(file.read)
            .mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
        )
      )
      const actualReadBytes = reads.reduce((sum, read) => sum + (read?.bytesRead ?? 0), 0)
      expect(actualReadBytes).toBe(total)
      expect(descriptors.every((file) => file.fd === -1)).toBe(true)
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
        staging,
        retries,
        prepared: prepared.size,
        applied,
        inputRetries,
        newInputBytes,
        retryInputBytes,
        maxTokens,
        maxFetched,
        actualReadBytes,
        opens: descriptors.length
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
  expect(measurements[1].prepared - 1).toBe((measurements[0].prepared - 1) * 10)
  expect(measurements[1].scalarParts).toBeGreaterThan(measurements[0].scalarParts * 5)
  expect(measurements[1].childStorage).toBe(measurements[0].childStorage)
  expect(measurements[1].staging).toBeGreaterThan(measurements[0].staging * 5)
  process.stdout.write(`semantic decoder resource contract ${JSON.stringify(measurements)}\n`)
})

it.each([
  { stream: 'child', at: -10, seam: 'before', size: 0 },
  { stream: 'child', at: 20, seam: 'before', size: 0 },
  { stream: 'child', at: 20, seam: 'before', size: 300_000 },
  { stream: 'child', at: 20, seam: 'wrapper', size: 0 },
  { stream: 'parent', at: -10, seam: 'before', size: 0 },
  { stream: 'parent', at: 20, seam: 'before', size: 0 },
  { stream: 'parent', at: 20, seam: 'after', size: 0 },
  { stream: 'parent', at: 20, seam: 'wrapper', size: 0 }
])(
  'acknowledges $stream G$at at $seam ($size bytes) on scheduled retry without a writer',
  async ({ stream, at, seam, size }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let rejected = false
    const reader: typeof readClaudeTranscriptChunk = (cursor, limit, consumer) =>
      readClaudeTranscriptChunk(
        cursor,
        limit,
        consumer && {
          ...consumer,
          consume: async (record, application) => {
            const target =
              stream === 'child'
                ? cursor.path.includes('subagents') && record.timestamp === stamp(at)
                : record.toolUseResult !== undefined
            if (target && stream === 'child' && seam === 'before' && !rejected) {
              rejected = true
              throw new RangeError('one recoverable application rejection')
            }
            const result = await consumer.consume(record, application)
            if (target && seam === 'wrapper' && !rejected) {
              rejected = true
              throw new RangeError('one recoverable application rejection')
            }
            return result
          }
        }
      )
    const p = await pane(true, reader)
    const key = p.row().paneKey
    const owner = p.poller['observations'].get(key)!
    const tasks: ClaudeLaunchedBackgroundTasks = new Map([
      ['a123', { kind: 'agent', notificationOwedAt: now }],
      ['shell', { kind: 'shell', notificationOwedAt: now }]
    ])
    try {
      p.replace(
        p.post({
          hook_event_name: 'PermissionRequest',
          agent_id: 'a123',
          tool_name: 'Bash',
          tool_use_id: 'rejection-approval',
          tool_input: { command: 'false' }
        })
      )
      p.state.claudeLaunchedBackgroundTasksByPaneKey.set(key, tasks)
      await appendFile(p.path, kill())
      if (stream === 'child') {
        const frame = size
          ? `${JSON.stringify({ type: 'user', timestamp: stamp(at), message: { content: [{ type: 'text', text: 'x'.repeat(size) }] } })}\n`
          : prompt(at)
        await (at === -10 ? writeFile : appendFile)(p.child('a123'), frame)
      } else {
        await appendFile(
          p.path,
          `${JSON.stringify({ type: 'assistant', timestamp: stamp(at), message: { content: [{ type: 'tool_use', name: 'Agent', id: 'resume' }] } })}\n${JSON.stringify(
            {
              type: 'user',
              toolUseResult: { isAsync: true, agentId: 'a123' },
              message: {
                content: [
                  { type: 'tool_result', tool_use_id: 'resume' },
                  { type: 'tool_result', tool_use_id: 'resume' }
                ]
              }
            }
          )}\n`
        )
        const set = owner.resumedAt.set.bind(owner.resumedAt)
        vi.spyOn(owner.resumedAt, 'set').mockImplementation((id, value) => {
          if (seam === 'after') {
            set(id, value)
          }
          if (!rejected && seam !== 'wrapper') {
            rejected = true
            expect(owner.launches.has('resume')).toBe(false)
            throw new RangeError('one recoverable application rejection')
          }
          return set(id, value)
        })
      }
      const pending = p.poller.poll(key)
      expect(p.poller.poll(key)).toBe(pending)
      await expect(pending).rejects.toThrow('one recoverable application rejection')
      const files = await Promise.all(
        vi
          .mocked(open)
          .mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
      )
      expect(files.every((file) => file?.fd === -1)).toBe(true)
      expect(p.publish).not.toHaveBeenCalled()
      expect(p.state.claudeLeadStateByPaneKey.get(key)?.waitingAgentId).toBe('a123')
      expect(tasks.get('a123')).toEqual({ kind: 'agent', notificationOwedAt: now })
      const cursor = stream === 'parent' ? owner.parent : owner.children.get('a123')!.cursor
      const retained = cursor.record!
      expect(retained.value).toBeDefined()
      if (stream === 'child' && at === 20 && seam === 'before') {
        expect(owner.children.get('a123')?.promptedAt).toBe(now - 10)
      }
      const due = vi.spyOn(p.poller, 'poll')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(due).toHaveBeenCalled()
      await Promise.all(
        due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
      )
      expect(cursor.record).toBeUndefined()
      expect(cursor.input).toBeUndefined()
      expect(retained.application.complete).toBe(true)
      if (stream === 'parent') {
        expect(owner.resumedAt.get('a123')).toBe(now + at)
        expect(owner.launches.size).toBe(0)
      }
      if (at === 20) {
        expect(p.row().payload.subagents?.[0]?.state).toBe('working')
        expect(p.state.claudeLeadStateByPaneKey.get(key)?.waitingAgentId).toBe('a123')
        expect(tasks.get('a123')).toEqual({ kind: 'agent', notificationOwedAt: now })
        expect(p.publish).not.toHaveBeenCalled()
        await appendFile(p.path, kill(30))
        await vi.advanceTimersByTimeAsync(5_000)
        await Promise.all(
          due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
        )
      }
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(p.state.claudeLeadStateByPaneKey.get(key)?.waitingAgentId).toBeUndefined()
      expect(tasks.get('a123')?.settled).toBe(true)
      expect(tasks.get('shell')).toEqual({ kind: 'shell', notificationOwedAt: now })
      expect(p.row().payload.lastAssistantMessage).toBe('READY')
      expect(p.row().payload.workingMode).toBe('monitoring')
      expect(p.publish).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      p.poller.clearAll()
      vi.useRealTimers()
    }
  }
)

it('resumes a pre-LF token after its effect and an accepted input after wrapper rejection across UTF-8/escape splits', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let tokenFault = false,
    inputFault = false,
    decoded = 0,
    projectionAttempts = 0
  const consume = ClaudeTranscriptDecoder.prototype['consume']
  ClaudeTranscriptDecoder.prototype['consume'] = function (
    this: ClaudeTranscriptDecoder,
    operation
  ) {
    projectionAttempts++
    consume.call(this, operation)
    if (this['scalar'] === 'selected' && this['parts'].join('') === 'é' && !tokenFault) {
      tokenFault = true
      throw new RangeError('projected token')
    }
  }
  const write = ClaudeTranscriptDecoder.prototype.write
  vi.spyOn(ClaudeTranscriptDecoder.prototype, 'write').mockImplementation(function (
    this: ClaudeTranscriptDecoder,
    text,
    checkpoint
  ) {
    const before = this.work
    try {
      write.call(this, text, checkpoint)
      if (tokenFault && !inputFault) {
        inputFault = true
        throw new RangeError('accepted input')
      }
    } finally {
      decoded += this.work - before
    }
  })
  const reader: typeof readClaudeTranscriptChunk = (cursor, _limit, consumer) =>
    readClaudeTranscriptChunk(cursor, 1, consumer)
  const p = await pane(true, reader)
  const key = p.row().paneKey
  try {
    const escaped = `{"type":"assistant","timestamp":"${stamp(20)}","message":{"content":[{"type":"tool_use","name":"Agent","id":"é\\uD83D\\uDE00"}]}}\n`
    const result = `${JSON.stringify({ type: 'user', toolUseResult: { isAsync: true, agentId: 'a123' }, message: { content: [{ type: 'tool_result', tool_use_id: 'é😀' }] } })}\n`
    await appendFile(p.path, kill() + escaped + result)
    const owner = p.poller['observations'].get(key)!
    const launches = vi.spyOn(owner.launches, 'set')
    for (let i = 0; !inputFault && i < 600; i++) {
      try {
        await p.poller.poll(key)
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError)
      }
    }
    expect(tokenFault && inputFault).toBe(true)
    expect(owner.launches.size).toBe(0)
    expect(owner.children.size).toBe(0)
    expect(owner.parent.decoding?.checkpoint.tokens).toBeDefined()
    const checkpoint = owner.parent.decoding!.checkpoint
    const position = owner.parent.offset
    const due = vi.spyOn(p.poller, 'poll')
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all(
      due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
    )
    expect(checkpoint.next).toBe(checkpoint.tokens!.length)
    expect(owner.parent.offset).toBeGreaterThanOrEqual(position)
    const total = Buffer.byteLength(await readFile(p.path))
    for (let i = 0; i < 500 && owner.parent.offset < total; i++) {
      await p.poller.poll(key)
    }
    for (let i = 0; i < 150; i++) {
      await p.poller.poll(key)
    }
    expect(launches.mock.calls).toEqual([['é😀', now + 20]])
    expect(owner.launches.size).toBe(0)
    expect(owner.resumedAt.get('a123')).toBe(now + 20)
    expect(owner.parent.offset).toBe(total)
    expect(owner.parent.decoding).toBeUndefined()
    expect(owner.parent.record).toBeUndefined()
    expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    expect(p.publish).not.toHaveBeenCalled()
    expect(projectionAttempts).toBe(decoded + 1)
    await appendFile(p.path, kill(30))
    for (let i = 0; i < 150; i++) {
      await p.poller.poll(key)
    }
    expect(p.publish).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    ClaudeTranscriptDecoder.prototype['consume'] = consume
    p.poller.clearAll()
    vi.useRealTimers()
  }
})

it.each(['pause', 'churn', 'owner', 'replace', 'shrink', 'clear'])(
  'keeps same-owner progress on pause and disposes it on %s at a real application yield',
  async (action) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const p = await pane(true)
    const key = p.row().paneKey
    const owner = p.poller['observations'].get(key)!
    try {
      const content = Array.from({ length: 520 }, (_, i) => ({
        type: 'tool_use',
        name: 'Agent',
        id: `batch-${i}`
      }))
      const frame = `${JSON.stringify({ type: 'assistant', timestamp: stamp(20), message: { content } })}\n`
      await appendFile(p.path, kill() + frame)
      let paused = false
      const set = owner.launches.set.bind(owner.launches)
      vi.spyOn(owner.launches, 'set').mockImplementation((id, value) => {
        if (!paused) {
          paused = true
          queueMicrotask(() => {
            if (action === 'churn') {
              p.replace(
                p.post({ hook_event_name: 'PreToolUse', agent_id: 'a123', tool_name: 'Bash' })
              )
            } else if (action === 'owner') {
              p.replace({
                ...p.row(),
                providerSession: { key: 'session_id', id: 'successor', transcriptPath: p.path }
              })
            } else {
              p.listen(false)
            }
          })
        }
        return set(id, value)
      })
      const pending = p.poller.poll(key)
      expect(p.poller.poll(key)).toBe(pending)
      await pending
      if (action === 'owner') {
        expect(owner.parent.record).toBeUndefined()
        expect(owner.parent.input).toBeUndefined()
        expect(owner.launches.size).toBe(511)
        const successor = p.poller['observations'].get(key)!
        expect(successor).not.toBe(owner)
        expect(successor.launches.size).toBe(0)
        expect(successor.parent.offset).toBe(0)
        expect(p.publish).not.toHaveBeenCalled()
        return
      }
      if (action === 'churn') {
        expect(owner.parent.record).toBeUndefined()
        expect(owner.launches.size).toBe(520)
        expect(p.publish).not.toHaveBeenCalled()
        const due = vi.spyOn(p.poller, 'poll')
        await vi.advanceTimersByTimeAsync(5_000)
        await Promise.all(
          due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
        )
        expect(p.publish).toHaveBeenCalledTimes(1)
        return
      }
      const retained = owner.parent.record!
      expect(retained.application.index).toBe(512)
      expect(retained.application.complete).not.toBe(true)
      expect(owner.launches.size).toBe(511)
      expect(owner.children.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(p.publish).not.toHaveBeenCalled()
      if (action === 'replace') {
        await writeFile(join(dir, 'successor.jsonl'), prompt(0))
        await rename(join(dir, 'successor.jsonl'), p.path)
      } else if (action === 'shrink') {
        await writeFile(p.path, prompt(0))
      } else if (action === 'clear') {
        p.poller.clearAll()
      }
      p.listen(true)
      const due = vi.spyOn(p.poller, 'poll')
      if (action === 'clear') {
        expect(owner.parent.record).toBeUndefined()
        expect(owner.parent.input).toBeUndefined()
        expect(p.poller['observations'].size).toBe(0)
      } else {
        await vi.advanceTimersByTimeAsync(5_000)
        await Promise.all(
          due.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
        )
        expect(owner.parent.record).toBeUndefined()
        if (action === 'pause') {
          expect(retained.application.complete).toBe(true)
          expect(owner.launches.size).toBe(520)
          expect(p.publish).toHaveBeenCalledTimes(1)
        } else {
          expect(retained.application.complete).not.toBe(true)
          expect(owner.launches.size).toBe(0)
          expect(owner.killedAt).toBeUndefined()
          expect(p.publish).not.toHaveBeenCalled()
        }
      }
    } finally {
      p.poller.clearAll()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    }
  }
)
