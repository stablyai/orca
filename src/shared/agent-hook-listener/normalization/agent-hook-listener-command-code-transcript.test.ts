import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { clearGrokSessionPathLookupCacheForTests } from '../../grok-session-paths'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('reads the last assistant message behind an oversized line without quadratic copying', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-assistant-huge-line-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    const originalConcat = Buffer.concat
    let concatenatedBytes = 0
    try {
      // Multi-block lines must join once; per-block carry joins copy quadratic bytes.
      const lineBytes = 2 * 1024 * 1024
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: 'answer behind a huge line' }]
        })}\n${JSON.stringify({
          role: 'user',
          content: [{ type: 'text', text: 'x'.repeat(lineBytes) }]
        })}\n`
      )

      Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
        const joined = originalConcat(list as Uint8Array[], totalLength)
        concatenatedBytes += joined.length
        return joined
      }) as typeof Buffer.concat

      const done = normalizeHookPayload(
        state,
        'claude',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: { hook_event_name: 'Stop', transcript_path: transcriptPath }
        },
        'production'
      )

      expect(done?.payload.lastAssistantMessage).toBe('answer behind a huge line')
      // Linear copies once (~lineBytes); the quadratic form copied many times that.
      expect(concatenatedBytes).toBeLessThan(lineBytes * 4)
    } finally {
      Buffer.concat = originalConcat
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Backward scanning must preserve boundary-spanning prompts, latest-user selection and absolute interaction offsets.
  it('reads a Command Code prompt that straddles the backward-scan chunk boundary', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-chunk-straddle-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      const promptLine = JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'straddling prompt' }]
      })
      // Straddle the 64KiB boundary counted backward from EOF.
      const chunkBytes = 64 * 1024
      const bytesAfterPrompt = chunkBytes - Math.floor(Buffer.byteLength(promptLine) / 2)
      const tail = Array.from({ length: 271 }, (_value, index) =>
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: `${'t'.repeat(180)}${index}` }]
        })
      )
      let tailText = `${tail.join('\n')}\n`
      const padBytes = bytesAfterPrompt - Buffer.byteLength(tailText)
      expect(padBytes).toBeGreaterThan(0)
      tailText = `${'x'.repeat(padBytes - 1)}\n${tailText}`
      expect(Buffer.byteLength(tailText)).toBe(bytesAfterPrompt)
      const head = Array.from({ length: 200 }, (_value, index) =>
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: `${'h'.repeat(180)}${index}` }]
        })
      )
      writeFileSync(transcriptPath, `${head.join('\n')}\n${promptLine}\n${tailText}`)

      const tool = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: {
            hook_event_name: 'PreToolUse',
            transcript_path: transcriptPath,
            tool_name: 'shell_command',
            tool_input: { command: 'pwd' }
          }
        },
        'production'
      )
      expect(tool?.payload.prompt).toBe('straddling prompt')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ignores a Command Code prompt older than the transcript scan cap', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-over-cap-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      // Put the only user line beyond 4MB so removing the read cap fails.
      const filler = JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'f'.repeat(64 * 1024) }]
      })
      const lines = [
        JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'ancient prompt' }] })
      ]
      for (let index = 0; index < 80; index += 1) {
        lines.push(filler)
      }
      writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
      expect(statSync(transcriptPath).size).toBeGreaterThan(4 * 1024 * 1024)

      const tool = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: {
            hook_event_name: 'PreToolUse',
            transcript_path: transcriptPath,
            tool_name: 'shell_command',
            tool_input: { command: 'pwd' }
          }
        },
        'production'
      )

      expect(tool?.payload).toMatchObject({
        state: 'working',
        agentType: 'command-code',
        prompt: '',
        toolName: 'shell_command',
        toolInput: 'pwd'
      })
      writeFileSync(transcriptPath, `${lines[0]}\n`, { flag: 'a' })
      const recent = normalizeHookPayload(
        createHookListenerState(),
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: { hook_event_name: 'PreToolUse', transcript_path: transcriptPath }
        },
        'production'
      )
      expect(recent?.payload.prompt).toBe('ancient prompt')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
