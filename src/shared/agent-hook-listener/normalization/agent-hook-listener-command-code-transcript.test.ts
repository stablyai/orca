import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
