import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { clearGrokSessionPathLookupCacheForTests } from './grok-session-paths'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('normalizes Command Code hooks and reads turn text from the transcript', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-transcript-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      writeFileSync(
        transcriptPath,
        `${[
          JSON.stringify({
            role: 'user',
            content: [{ type: 'text', text: 'Run pwd and report it' }]
          }),
          JSON.stringify({
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Need to run pwd.' },
              { type: 'text', text: 'The output is /tmp/project.' }
            ]
          })
        ].join('\n')}\n`
      )

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
        prompt: 'Run pwd and report it',
        agentType: 'command-code',
        toolName: 'shell_command',
        toolInput: 'pwd'
      })
      expect(tool?.hasExplicitPrompt).toBe(true)
      expect(tool?.promptInteractionKey).toMatch(/^command-code-transcript-[a-f0-9]{12}-/)

      const directPrompt = normalizeHookPayload(
        createHookListenerState(),
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            prompt: 'Direct command prompt'
          }
        },
        'production'
      )
      expect(directPrompt?.hasExplicitPrompt).toBe(true)

      const directPromptWithTranscript = normalizeHookPayload(
        createHookListenerState(),
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            prompt: 'Run pwd and report it',
            transcript_path: transcriptPath
          }
        },
        'production'
      )
      expect(directPromptWithTranscript?.hasExplicitPrompt).toBe(true)
      expect(directPromptWithTranscript?.promptInteractionKey).toBe(tool?.promptInteractionKey)

      const statusMessage = normalizeHookPayload(
        createHookListenerState(),
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            message: 'Preparing tool call'
          }
        },
        'production'
      )
      expect(statusMessage?.hasExplicitPrompt).toBe(false)

      const done = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: {
            hook_event_name: 'Stop',
            transcript_path: transcriptPath
          }
        },
        'production'
      )
      expect(done?.payload).toMatchObject({
        state: 'done',
        prompt: 'Run pwd and report it',
        agentType: 'command-code',
        lastAssistantMessage: 'The output is /tmp/project.'
      })
      expect(done?.promptInteractionKey).toBe(tool?.promptInteractionKey)

      const cachedOnly = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: {
            hook_event_name: 'Stop'
          }
        },
        'production'
      )
      expect(cachedOnly?.payload.prompt).toBe('Run pwd and report it')
      expect(cachedOnly?.hasExplicitPrompt).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads newline-heavy Command Code transcripts without line-array splitting', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-large-transcript-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      const filler = Array.from({ length: 6_000 }, (_value, index) =>
        JSON.stringify({
          role: index % 2 === 0 ? 'assistant' : 'user',
          content: [{ type: 'text', text: `filler ${index}` }]
        })
      )
      writeFileSync(
        transcriptPath,
        `${[
          ...filler,
          JSON.stringify({
            role: 'user',
            content: [{ type: 'text', text: 'large transcript prompt' }]
          }),
          JSON.stringify({
            role: 'assistant',
            content: [{ type: 'text', text: 'large transcript answer' }]
          })
        ].join('\n')}\n`
      )
      const splitSpy = vi.spyOn(String.prototype, 'split')

      const tool = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            transcript_path: transcriptPath,
            tool_name: 'shell_command',
            tool_input: { command: 'pwd' }
          }
        },
        'production'
      )
      const done = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'Stop',
            transcript_path: transcriptPath
          }
        },
        'production'
      )

      expect(tool?.payload.prompt).toBe('large transcript prompt')
      expect(done?.payload.lastAssistantMessage).toBe('large transcript answer')
      const usedLineArraySplit = splitSpy.mock.calls.some(
        ([separator]) => typeof separator === 'string' && separator === '\n'
      )
      expect(usedLineArraySplit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads the last assistant message behind an oversized line without quadratic copying', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-assistant-huge-line-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    const originalConcat = Buffer.concat
    let concatenatedBytes = 0
    try {
      // The shared backward reader (readLastTextFromTranscriptOnce) stitches a
      // line spanning many read blocks. Re-joining the carry per block copies
      // O(line^2); the chunk list defers to one join.
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

  // Why these three: the prompt read scans backward from EOF and stops at the
  // first user line, so the cases that can break are a prompt spanning a chunk
  // boundary, a later prompt that must win over an earlier one, and the byte
  // offset in interactionKey, which the old forward pass computed absolutely.
  it('reads a Command Code prompt that straddles the backward-scan chunk boundary', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-chunk-straddle-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      const promptLine = JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'straddling prompt' }]
      })
      // Place the prompt so it spans the 64 KiB read boundary counted back from
      // EOF: the scan must stitch the two reads together to see the whole line.
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

  it('reads a prompt behind one oversized line without quadratic carry copying', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-huge-line-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    const originalConcat = Buffer.concat
    let concatenatedBytes = 0
    try {
      // A single tool result spanning many 64 KiB read blocks. Re-joining the
      // accumulated carry per block copies O(line^2) bytes; the chunk list defers
      // to one join, so total copied bytes stay proportional to the line.
      const lineBytes = 2 * 1024 * 1024
      const hugeLine = JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(lineBytes) }]
      })
      const promptLine = JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'prompt behind a huge tool result' }]
      })
      writeFileSync(transcriptPath, `${promptLine}\n${hugeLine}\n`)

      Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
        const joined = originalConcat(list as Uint8Array[], totalLength)
        concatenatedBytes += joined.length
        return joined
      }) as typeof Buffer.concat

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

      expect(tool?.payload.prompt).toBe('prompt behind a huge tool result')
      // Linear copies once (~lineBytes). The quadratic form copied ~16x that at
      // this size and grows with the square, so 4x separates them decisively.
      expect(concatenatedBytes).toBeLessThan(lineBytes * 4)
    } finally {
      Buffer.concat = originalConcat
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads a Command Code prompt line that spans several read blocks', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-long-line-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      // A prompt longer than one 64 KiB block: the scan sees consecutive blocks
      // with no newline at all and must stitch them before parsing.
      const promptText = `pasted prompt ${'W'.repeat(150 * 1024)}`
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'earlier' }] })}\n${JSON.stringify(
          { role: 'user', content: [{ type: 'text', text: promptText }] }
        )}\n${JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'tail' }] })}\n`
      )

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

      expect(tool?.payload.prompt.startsWith('pasted prompt WWW')).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ignores a Command Code prompt older than the transcript scan cap', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-over-cap-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      // The only user line sits beyond the 4 MB cap, so the bounded scan must not
      // reach it — dropping the cap would restore the unbounded read this avoids.
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

      expect(tool?.payload.prompt ?? '').toBe('')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('resolves the last Command Code prompt, not an earlier one', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-last-prompt-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      writeFileSync(
        transcriptPath,
        `${[
          JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'first ask' }] }),
          JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }),
          JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'second ask' }] }),
          JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'second answer' }] })
        ].join('\n')}\n`
      )

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
      expect(tool?.payload.prompt).toBe('second ask')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keys the Command Code interaction by the absolute prompt line offset', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-offset-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      const prompt = JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'same text' }]
      })
      const answer = JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'a' }] })
      // Why past one chunk: the offset is absolute over the whole file, so the
      // prompt must sit beyond a single backward-scan read for a chunk-relative
      // offset to be distinguishable from the correct one.
      const filler = Array.from({ length: 900 }, (_value, index) =>
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: `${'f'.repeat(200)}${index}` }]
        })
      )
      const head = `${filler.join('\n')}\n`
      writeFileSync(transcriptPath, `${head}${prompt}\n${answer}\n`)
      const promptOffset = Buffer.byteLength(head)
      expect(promptOffset).toBeGreaterThan(64 * 1024)

      const key = normalizeHookPayload(
        createHookListenerState(),
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
      )?.promptInteractionKey

      // The offset segment must be the prompt line's real position in the file;
      // a chunk-relative value would make two turns collide across reads.
      // Key shape: command-code-transcript-<pathHash>-<offset>-<textHash>.
      expect(key?.split('-')[4]).toBe(String(promptOffset))
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('trims surrounding whitespace from extracted prompt text', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: '   hi   ' }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.prompt).toBe('hi')
  })
})
