import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('uses the hook envelope Grok home instead of the listener service environment', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-envelope-home-'))
    const serviceGrokHome = join(tmpDir, 'service-grok')
    const hookGrokHome = join(tmpDir, 'hook-grok')
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf529'
    const cwd = join(tmpDir, 'workspace')
    const sessionDir = join(hookGrokHome, 'sessions', encodeURIComponent(cwd), sessionId)
    try {
      vi.stubEnv('GROK_HOME', serviceGrokHome)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'from effective Grok home' })}\n`
      )

      const done = normalizeHookPayload(
        state,
        'grok',
        {
          paneKey: PANE_KEY,
          grokHome: hookGrokHome,
          payload: { hookEventName: 'Stop', sessionId, cwd }
        },
        'production'
      )

      expect(done?.payload.lastAssistantMessage).toBe('from effective Grok home')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not let Grok sessionId escape the chat-history directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-session-escape-'))
    const cwd = join(tmpDir, 'workspace')
    const escapedDir = join(tmpDir, '.grok', 'sessions', 'escaped')
    try {
      vi.stubEnv('HOME', tmpDir)
      vi.stubEnv('USERPROFILE', tmpDir)
      mkdirSync(escapedDir, { recursive: true })
      writeFileSync(
        join(escapedDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'should not leak' })}\n`
      )

      const done = normalizeHookPayload(
        state,
        'grok',
        {
          paneKey: PANE_KEY,
          payload: { hookEventName: 'Stop', sessionId: '../escaped', cwd }
        },
        'production'
      )

      expect(done?.payload.state).toBe('done')
      expect(done?.payload.lastAssistantMessage).toBeUndefined()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
