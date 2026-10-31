import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
    vi.restoreAllMocks()
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

  it('reads a prompt behind one oversized line without quadratic carry copying', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-huge-line-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    const originalConcat = Buffer.concat
    let concatenatedBytes = 0
    try {
      // A single multi-block tool result exposes quadratic carry concatenation.
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
      // A 4x copy bound separates one linear join from the old ~16x amplification.
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
      // Prompts exceeding 64KiB require stitching blocks with no newline.
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

      expect(tool?.payload.prompt).toBe(promptText.slice(0, 200))
      expect(tool?.promptInteractionKey?.split('-')[5]).toBe(
        createHash('sha256').update(promptText).digest('hex').slice(0, 12)
      )
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
      // Place the prompt beyond one chunk to distinguish absolute and chunk-relative offsets.
      const filler = Array.from({ length: 900 }, (_value, index) =>
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: `😀${'f'.repeat(200)}${index}` }]
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

      // The key's offset must be absolute or turns can collide across reads.
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
