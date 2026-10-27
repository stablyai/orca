import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

/** Live OpenCode 1.18.18 captures, also exercised through mimo-code’s shared normalizer. SDK EventPermissionAsked maps permission.asked properties
 * to PermissionRequest: permission names the tool, patterns the commands/paths, metadata holds untyped tool-specific fields.
 * Preserve captured metadata shapes: prior invented {} fixtures never exercised the real edit path. */
describe('OpenCode-family permission request status', () => {
  let state: ReturnType<typeof createHookListenerState>

  beforeEach(() => {
    state = createHookListenerState()
  })

  const SOURCES = ['opencode', 'opencode2', 'mimo-code'] as const

  function permissionEvent(
    source: (typeof SOURCES)[number],
    properties: Record<string, unknown>
  ): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(
      state,
      source,
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'PermissionRequest', ...properties }
      },
      'production'
    )
  }

  function lifecycleEvent(
    source: (typeof SOURCES)[number],
    eventName: string,
    properties: Record<string, unknown> = {}
  ): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(
      state,
      source,
      { paneKey: PANE_KEY, payload: { hook_event_name: eventName, ...properties } },
      'production'
    )
  }

  const BASH_PERMISSION = {
    id: 'per_01',
    sessionID: 'ses_root',
    permission: 'bash',
    patterns: ['rm -rf build/'],
    metadata: { command: 'rm -rf build/' },
    always: []
  }

  it.each(SOURCES)('reports a permission request as waiting for %s', (source) => {
    const event = permissionEvent(source, BASH_PERMISSION)

    expect(event?.payload.state).toBe('waiting')
    expect(event?.payload.agentType).toBe(source)
  })

  it.each(SOURCES)('names the requested permission as the tool for %s', (source) => {
    const event = permissionEvent(source, BASH_PERMISSION)

    // Permission name always identifies what is blocked; bare waiting hides it (STA-3160).
    expect(event?.payload.toolName).toBe('bash')
  })

  it.each(SOURCES)('surfaces the blocked command as tool input for %s', (source) => {
    const event = permissionEvent(source, BASH_PERMISSION)

    expect(event?.payload.toolInput).toBe('rm -rf build/')
  })

  it.each(SOURCES)('carries the real v2 shell request as an approval card for %s', (source) => {
    const event = permissionEvent(source, {
      id: 'per_native',
      sessionID: 'ses_native',
      permission: 'shell',
      patterns: ['printf PERMISSION_NATIVE_OK'],
      source: { type: 'tool', messageID: 'msg_native', id: 'functions.shell:0' }
    })
    expect(event?.payload.interactivePrompt).toBe(
      JSON.stringify({
        approval: { tool: 'shell', summary: 'printf PERMISSION_NATIVE_OK' }
      })
    )
  })

  it.each(SOURCES)('names the edited file for %s', (source) => {
    // OpenCode 1.18.18 capture: edit uses filepath (one word) alongside the full patch.
    const event = permissionEvent(source, {
      id: 'per_02',
      sessionID: 'ses_root',
      permission: 'edit',
      patterns: ['private/tmp/oc-perm-probe/notes.md'],
      metadata: {
        filepath: '/private/tmp/oc-perm-probe/notes.md',
        diff: '@@ -0,0 +1,1 @@\n+hello world\n\\ No newline at end of file\n'
      },
      always: ['*']
    })

    expect(event?.payload.toolName).toBe('edit')
    expect(event?.payload.toolInput).toBe('/private/tmp/oc-perm-probe/notes.md')
  })

  it.each(SOURCES)('never previews a diff as the blocked target for %s', (source) => {
    const event = permissionEvent(source, {
      id: 'per_03',
      sessionID: 'ses_root',
      permission: 'edit',
      patterns: ['src/a.ts'],
      metadata: { diff: '@@ -1 +1 @@\n-before\n+after\n' },
      always: []
    })

    // Why: `diff` is the largest field OpenCode sends and would swamp a one-line row.
    expect(event?.payload.toolInput).not.toContain('@@')
  })

  it.each(SOURCES)('names the fetched url for %s', (source) => {
    // Captured verbatim from opencode 1.18.18.
    const event = permissionEvent(source, {
      id: 'per_04',
      sessionID: 'ses_root',
      permission: 'webfetch',
      patterns: ['https://example.com'],
      metadata: { url: 'https://example.com', format: 'markdown' },
      always: ['*']
    })

    expect(event?.payload.toolName).toBe('webfetch')
    expect(event?.payload.toolInput).toBe('https://example.com')
  })

  it.each(SOURCES)('falls back to patterns when metadata is unrecognized for %s', (source) => {
    // Unknown tools may use arbitrary metadata keys; patterns is the common permission fallback.
    const event = permissionEvent(source, {
      id: 'per_05',
      sessionID: 'ses_root',
      permission: 'some_mcp_tool',
      patterns: ['src/a.ts', 'src/b.ts'],
      metadata: { unrecognizedKey: 'ignored' },
      always: []
    })

    expect(event?.payload.toolName).toBe('some_mcp_tool')
    expect(event?.payload.toolInput).toBe('src/a.ts, src/b.ts')
  })

  it.each(SOURCES)(
    'still reports waiting when the payload names no permission for %s',
    (source) => {
      // Unknown permission details cannot clear the blocked state; the user still owes an answer.
      const event = permissionEvent(source, { id: 'per_06', sessionID: 'ses_root' })

      expect(event?.payload.state).toBe('waiting')
      expect(event?.payload.toolName).toBeUndefined()
    }
  )

  it.each(SOURCES)('leaves the AskUserQuestion route untouched for %s', (source) => {
    const properties = { questions: [{ question: 'Choose', options: ['x', 'y'] }] }
    const event = normalizeHookPayload(
      state,
      source,
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'AskUserQuestion', ...properties }
      },
      'production'
    )

    expect(event?.payload.state).toBe('waiting')
    expect(event?.payload.interactivePrompt).toBe(JSON.stringify(properties))
  })

  it.each(SOURCES)('clears permission metadata once the turn resumes for %s', (source) => {
    permissionEvent(source, BASH_PERMISSION)
    const resumed = lifecycleEvent(source, 'SessionBusy')

    // Retire answered approval details as work resumes so stale commands cannot appear live.
    expect(resumed?.payload.state).toBe('working')
    expect(resumed?.payload.toolName).toBeUndefined()
    expect(resumed?.payload.toolInput).toBeUndefined()
    expect(resumed?.payload.interactivePrompt).toBeUndefined()
  })

  it.each(SOURCES)('retires the permission when the session goes idle for %s', (source) => {
    permissionEvent(source, BASH_PERMISSION)
    const idle = lifecycleEvent(source, 'SessionIdle')

    expect(idle?.payload.state).toBe('done')
    expect(idle?.payload.toolName).toBeUndefined()
    expect(idle?.payload.toolInput).toBeUndefined()
    expect(idle?.payload.interactivePrompt).toBeUndefined()
  })

  it.each(SOURCES)(
    'does not label a later question with the answered permission for %s',
    (source) => {
      permissionEvent(source, BASH_PERMISSION)
      const question = lifecycleEvent(source, 'AskUserQuestion', {
        questions: [{ question: 'Choose', options: ['x', 'y'] }]
      })

      expect(question?.payload.state).toBe('waiting')
      expect(question?.payload.toolName).toBeUndefined()
      expect(question?.payload.toolInput).toBeUndefined()
    }
  )

  it.each(SOURCES)('does not attribute the answered permission to a reply for %s', (source) => {
    permissionEvent(source, BASH_PERMISSION)
    const part = lifecycleEvent(source, 'MessagePart', { role: 'assistant', text: 'Ran it.' })

    expect(part?.payload.lastAssistantMessage).toBe('Ran it.')
    expect(part?.payload.toolName).toBeUndefined()
    expect(part?.payload.toolInput).toBeUndefined()
  })

  it.each(SOURCES)('does not carry an answered permission into a later wait for %s', (source) => {
    // Later ordinary waits also show tool fields, so answered permission details must be retired before the next question.
    permissionEvent(source, BASH_PERMISSION)
    lifecycleEvent(source, 'SessionBusy')
    lifecycleEvent(source, 'SessionIdle')
    const laterQuestion = lifecycleEvent(source, 'AskUserQuestion', {
      questions: [{ question: 'Which branch?', options: ['main', 'dev'] }]
    })

    expect(laterQuestion?.payload.state).toBe('waiting')
    expect(laterQuestion?.payload.toolInput).toBeUndefined()
    expect(laterQuestion?.payload.toolName).toBeUndefined()
  })

  it.each(SOURCES)('does not carry an answered permission into a later turn for %s', (source) => {
    // This family lacks mid-session isNewTurnEvent resets; explicitly retire permissions or their commands persist across later turns.
    permissionEvent(source, BASH_PERMISSION)
    lifecycleEvent(source, 'SessionBusy')
    lifecycleEvent(source, 'SessionIdle')
    const laterTurn = lifecycleEvent(source, 'SessionBusy')

    expect(laterTurn?.payload.state).toBe('working')
    expect(laterTurn?.payload.toolInput).toBeUndefined()
    expect(laterTurn?.payload.toolName).toBeUndefined()
  })
})
