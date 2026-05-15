import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createHookListenerState,
  getEndpointFileName,
  isShellSafeEndpointValue,
  normalizeHookPayload,
  parseFormEncodedBody,
  resolveHookSource,
  writeEndpointFile,
  type HookListenerState
} from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('parses form-encoded bodies', () => {
    const decoded = parseFormEncodedBody('paneKey=tab-1%3A0&worktreeId=foo')
    expect(decoded.paneKey).toBe('tab-1:0')
    expect(decoded.worktreeId).toBe('foo')
  })

  it('routes pathnames to a known source or null', () => {
    expect(resolveHookSource('/hook/claude')).toBe('claude')
    expect(resolveHookSource('/hook/cursor')).toBe('cursor')
    expect(resolveHookSource('/hook/grok')).toBe('grok')
    expect(resolveHookSource('/hook/unknown')).toBeNull()
    expect(resolveHookSource('/')).toBeNull()
  })

  it('rejects shell-unsafe endpoint values', () => {
    expect(isShellSafeEndpointValue('1234')).toBe(true)
    expect(isShellSafeEndpointValue('abc-DEF.0_1')).toBe(true)
    expect(isShellSafeEndpointValue('')).toBe(false)
    expect(isShellSafeEndpointValue('foo&bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo;bar')).toBe(false)
  })

  it('normalizes a Claude UserPromptSubmit body to a working state', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.paneKey).toBe(PANE_KEY)
    expect(event!.connectionId).toBeNull()
    expect(event!.payload.state).toBe('working')
    expect(event!.payload.prompt).toBe('hello')
    expect(event!.payload.agentType).toBe('claude')
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

  it('rejects oversized paneKey', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'x'.repeat(300),
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }
      },
      'production'
    )
    expect(event).toBeNull()
  })

  it('isolates caches between listener instances', () => {
    const a = createHookListenerState()
    const b = createHookListenerState()
    normalizeHookPayload(
      a,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'UserPromptSubmit', prompt: 'first' } },
      'production'
    )
    // The second listener has no cached prompt for this paneKey, so a tool
    // event without a fresh prompt should produce empty prompt string.
    const event = normalizeHookPayload(
      b,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/etc/hosts' }
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.prompt).toBe('')
  })

  it('normalizes Grok hookEventName payloads and keeps prompt across tool events', () => {
    const prompt = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        payload: { hookEventName: 'user_prompt_submit', prompt: 'run the check' }
      },
      'production'
    )
    expect(prompt).not.toBeNull()
    expect(prompt!.payload).toMatchObject({
      state: 'working',
      prompt: 'run the check',
      agentType: 'grok'
    })

    const tool = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        payload: {
          hookEventName: 'pre_tool_use',
          toolName: 'run_terminal_cmd',
          toolInput: { command: 'pnpm test' }
        }
      },
      'production'
    )
    expect(tool).not.toBeNull()
    expect(tool!.payload).toMatchObject({
      state: 'working',
      prompt: 'run the check',
      agentType: 'grok',
      toolName: 'run_terminal_cmd',
      toolInput: 'pnpm test'
    })
  })

  it('maps Grok feedback notifications to waiting without overwriting the prompt', () => {
    normalizeHookPayload(
      state,
      'grok',
      { paneKey: PANE_KEY, payload: { hookEventName: 'UserPromptSubmit', prompt: 'ship it' } },
      'production'
    )

    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: { hookEventName: 'Notification', message: 'Grok needs your feedback to proceed' }
      },
      'production'
    )

    expect(event).not.toBeNull()
    expect(event!.payload).toMatchObject({
      state: 'waiting',
      prompt: 'ship it',
      agentType: 'grok'
    })
  })

  describe('writeEndpointFile', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-hook-listener-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes the endpoint file atomically with the right contents and mode', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'abcdef-0123',
        env: 'production',
        version: '1'
      })
      expect(ok).toBe(true)
      const text = readFileSync(finalPath, 'utf8')
      expect(text).toContain('ORCA_AGENT_HOOK_PORT=12345')
      expect(text).toContain('ORCA_AGENT_HOOK_TOKEN=abcdef-0123')
      expect(text).toContain('ORCA_AGENT_HOOK_VERSION=1')
      // POSIX 0o600 — owner read/write only.
      if (process.platform !== 'win32') {
        const mode = statSync(finalPath).mode & 0o777
        expect(mode).toBe(0o600)
      }
    })

    it('refuses unsafe values', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'safe-token',
        env: 'foo&bar',
        version: '1'
      })
      expect(ok).toBe(false)
    })
  })
})
