import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

/**
 * OpenCode reports an approval prompt as `permission.asked`; the status plugin forwards
 * that event's `properties` under `hook_event_name: 'PermissionRequest'`. The shape is
 * fixed by @opencode-ai/sdk 1.18.18 (`EventPermissionAsked`): `permission` names what is
 * being requested, `patterns` carries the concrete commands/paths it applies to, and
 * `metadata` holds tool-specific detail.
 *
 * Only those outer names are typed — `metadata` is `Record<string, unknown>`, so the keys
 * inside it come from each tool. The payloads below were captured from a live opencode
 * 1.18.18 rather than invented, because the first version of this suite guessed a shape
 * (`metadata: {}`) that OpenCode never emits and so never exercised the real `edit` path.
 *
 * `normalizeOpenCodeFamilyEvent` serves opencode and mimo-code from one path, so every
 * case here runs for both.
 */
describe('OpenCode-family permission request status', () => {
  let state: ReturnType<typeof createHookListenerState>

  beforeEach(() => {
    state = createHookListenerState()
  })

  const SOURCES = ['opencode', 'mimo-code'] as const

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

    // Why: a bare `waiting` row cannot tell the user what is blocked; the permission
    // name is the only field that always identifies it (STA-3160).
    expect(event?.payload.toolName).toBe('bash')
  })

  it.each(SOURCES)('surfaces the blocked command as tool input for %s', (source) => {
    const event = permissionEvent(source, BASH_PERMISSION)

    expect(event?.payload.toolInput).toBe('rm -rf build/')
  })

  it.each(SOURCES)('names the edited file for %s', (source) => {
    // Captured verbatim from opencode 1.18.18 — an `edit` request keys its path as
    // `filepath` (one word) and ships the whole patch alongside it.
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
    // Why: `metadata` is typed `Record<string, unknown>` by the SDK, so a tool Orca has
    // never seen (an MCP server's, say) can key its detail anything — patterns is the one
    // field every permission carries.
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
      // Why: an unrecognized/absent permission must not downgrade the blocked state — the
      // user still has to answer, they just get less detail.
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

    // Why: a stale approval card must not outlive the approval — once work resumes the
    // row is working again and the blocked command is no longer what the pane is on.
    expect(resumed?.payload.state).toBe('working')
    expect(resumed?.payload.toolName).toBeUndefined()
    expect(resumed?.payload.toolInput).toBeUndefined()
  })

  it.each(SOURCES)('retires the permission when the session goes idle for %s', (source) => {
    permissionEvent(source, BASH_PERMISSION)
    const idle = lifecycleEvent(source, 'SessionIdle')

    expect(idle?.payload.state).toBe('done')
    expect(idle?.payload.toolName).toBeUndefined()
    expect(idle?.payload.toolInput).toBeUndefined()
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
    // Why: the row now shows tool fields on 'waiting' as well as 'working' (that is the whole
    // point of STA-3160), so a later non-permission wait must arrive with none — otherwise
    // relaxing the row gate turns an answered command into the question's caption.
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
    // Why: no isNewTurnEvent boundary fires mid-session for this family, so nothing else
    // resets the cached tool. Without an explicit retire, one permission pins its command to
    // every later working frame in the pane — the exact stale-tool-line the row gate guards against.
    permissionEvent(source, BASH_PERMISSION)
    lifecycleEvent(source, 'SessionBusy')
    lifecycleEvent(source, 'SessionIdle')
    const laterTurn = lifecycleEvent(source, 'SessionBusy')

    expect(laterTurn?.payload.state).toBe('working')
    // Why: assert the command first — it is the string a user would misread as live work.
    expect(laterTurn?.payload.toolInput).toBeUndefined()
    expect(laterTurn?.payload.toolName).toBeUndefined()
  })
})
