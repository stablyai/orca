import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../main/agent-hooks/server'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'

vi.mock('../../main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../main/telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
const quotaReads = vi.hoisted(() => ({ bytes: 0, failNext: false, failAlways: false, failures: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    readSync: vi.fn(
      (
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number | NodeFs.ReadSyncOptions = {},
        length?: number,
        position?: number | null
      ) => {
        const quotaRead = new Error('quota reader operation counter').stack?.includes(
          'readClaudeTerminalUsageLimit'
        )
        if (quotaRead && (quotaReads.failNext || quotaReads.failAlways)) {
          quotaReads.failNext = false
          quotaReads.failures += 1
          throw Object.assign(new Error('transient quota read failure'), { code: 'EIO' })
        }
        const bytes =
          typeof offset === 'number'
            ? fs.readSync(
                fd,
                buffer,
                offset,
                length ?? buffer.byteLength - offset,
                position ?? null
              )
            : fs.readSync(fd, buffer, offset)
        if (quotaRead) {
          quotaReads.bytes += bytes
        }
        return bytes
      }
    )
  }
})
afterEach(() => {
  quotaReads.failNext = false
  quotaReads.failAlways = false
  quotaReads.failures = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

const scenarios = [
  ...(['local', 'guest'] as const).flatMap((kind) =>
    [64, 640].flatMap((rows) =>
      (['append', 'replace', 'truncate', 'read-error'] as const).map((change) => ({
        kind,
        rows,
        change
      }))
    )
  ),
  { kind: 'local' as const, rows: 64, change: 'persistent-read-error' as const }
]
it.each(scenarios)(
  '$kind refines $change after $rows unchanged metadata rows',
  async ({ kind, rows, change }) => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    _internals.resetCachesForTests()
    const directory = mkdtempSync(join(tmpdir(), 'claude-quota-refinement-budget-'))
    const path = join(directory, 'transcript.jsonl')
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const promptId = '22222222-2222-4222-8222-222222222222'
    const sessionId = '44444444-4444-4444-8444-444444444444'
    const root = {
      type: 'user',
      uuid: 'user',
      parentUuid: null,
      sessionId,
      promptId,
      isSidechain: false,
      message: { content: 'Finish' }
    }
    const assistant = {
      type: 'assistant',
      uuid: 'assistant',
      parentUuid: 'user',
      sessionId,
      isSidechain: false,
      message: { content: [{ type: 'text', text: 'Existing text' }] }
    }
    const prefix = `${JSON.stringify(root)}\n${JSON.stringify(assistant)}\n`
    const metadata = `${JSON.stringify({ type: 'progress', content: 'x'.repeat(1000) })}\n`
    writeFileSync(path, `${prefix}${metadata.repeat(rows)}`)
    const local = new AgentHookServer()
    const guest = new RelayAgentHookServer({ endpointDir: directory, forward: () => undefined })
    const server = kind === 'local' ? local : guest
    try {
      await (kind === 'local'
        ? local.start({ env: 'production', userDataPath: directory })
        : guest.start())
      const env = kind === 'local' ? local.buildPtyEnv() : undefined
      const { port, token } =
        kind === 'guest'
          ? guest.getCoordinates()
          : { port: env!.ORCA_AGENT_HOOK_PORT, token: env!.ORCA_AGENT_HOOK_TOKEN }
      const post = async (payload: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
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
              prompt_id: promptId,
              transcript_path: path,
              ...payload
            }
          })
        })
        expect(response.status).toBe(204)
      }
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Finish' })
      await post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_response: 'Existing text'
      })
      quotaReads.bytes = 0
      await post({
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        last_assistant_message: 'Existing text'
      })
      const current = () => server['state'].lastStatusByPaneKey.get(paneKey)
      expect(current()?.payload.mainAgent?.usageLimit).toBeUndefined()
      expect(current()?.payload.lastAssistantMessage).toBeTruthy()
      expect(quotaReads.bytes).toBeGreaterThan(0)
      vi.advanceTimersByTime(50)
      const afterFirstRetry = quotaReads.bytes
      vi.advanceTimersByTime(100)
      expect(quotaReads.bytes).toBe(afterFirstRetry)
      const quota = `${JSON.stringify({
        type: 'assistant',
        uuid: 'quota',
        parentUuid: 'assistant',
        sessionId,
        isSidechain: false,
        apiError: 'usage_limit_reached'
      })}\n`
      if (change === 'append' || change === 'read-error' || change === 'persistent-read-error') {
        appendFileSync(path, quota)
      } else if (change === 'replace') {
        const length = statSync(path).size
        const replacement = join(directory, 'replacement.jsonl')
        writeFileSync(
          replacement,
          `${prefix}${quota}${' '.repeat(length - Buffer.byteLength(prefix + quota))}`
        )
        renameSync(replacement, path)
        expect(statSync(path).size).toBe(length)
      } else {
        writeFileSync(path, `${prefix}${quota}`)
        expect(readFileSync(path, 'utf8')).toBe(`${prefix}${quota}`)
      }
      if (change === 'persistent-read-error') {
        quotaReads.failAlways = true
        vi.advanceTimersByTime(500)
        expect(quotaReads.failures).toBe(2)
        expect(current()?.payload.mainAgent?.usageLimit).toBeUndefined()
        expect(local['assistantMessageRetryTimers'].size).toBe(0)
        vi.advanceTimersByTime(500)
        expect(quotaReads.failures).toBe(2)
        return
      }
      if (change === 'read-error') {
        quotaReads.failNext = true
        vi.advanceTimersByTime(50)
        expect(quotaReads.failNext).toBe(false)
        expect(quotaReads.failures).toBe(1)
        expect(current()?.payload.mainAgent?.usageLimit).toBeUndefined()
      }
      vi.advanceTimersByTime(50)
      expect(current()?.payload.mainAgent?.usageLimit).toEqual({})
      expect(quotaReads.bytes).toBeGreaterThan(afterFirstRetry)
      const afterQuota = quotaReads.bytes
      vi.advanceTimersByTime(500)
      expect(quotaReads.bytes).toBe(afterQuota)
      expect(vi.mocked(readSync)).toHaveBeenCalled()
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
