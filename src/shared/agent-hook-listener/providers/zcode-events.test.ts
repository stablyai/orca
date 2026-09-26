import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'

const SESSION_ID = 'sess_01a0caa30e777d41bad746283a45633d'
const TURN_ID = 'turn_e495d1a559aa478efba1bd75509afc'

/**
 * ZCode's hook runner writes its own camelCase fields AND a Claude-compatible alias set
 * onto the same stdin object (`createCompatibleHookStdin`), so every fixture below carries
 * both — that is literally what lands on the wire.
 */
function zcodeEvent(
  hookEventName: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    cwd: '/tmp/ws',
    hookEventName,
    hook_event_name: hookEventName,
    mode: 'build',
    permission_mode: 'build',
    sessionId: SESSION_ID,
    session_id: SESSION_ID,
    timestamp: '2026-09-23T07:50:00.000Z',
    traceId: 'tr_1',
    turnId: TURN_ID,
    ...extra
  }
}

function toolFields(toolName: string, toolInput: unknown): Record<string, unknown> {
  return {
    toolName,
    tool_name: toolName,
    toolInput,
    tool_input: toolInput,
    toolCallId: 'call_1',
    tool_use_id: 'call_1'
  }
}

let state: HookListenerState
beforeEach(() => {
  state = createHookListenerState()
})

describe('normalizeZCodeEvent', () => {
  it('lands a startup SessionStart as an idle session boundary, not a spinner', () => {
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('SessionStart', { source: 'startup' })
    )
    expect(event?.payload).toMatchObject({
      state: 'done',
      agentType: 'zcode',
      sessionBoundary: true
    })
  })

  it('drops a compact SessionStart, which fires mid-turn', () => {
    expect(
      normalizeAndAccept(state, 'zcode', zcodeEvent('SessionStart', { source: 'compact' }))
    ).toBeNull()
  })

  it('reports working from UserPromptSubmit and carries the prompt', () => {
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('UserPromptSubmit', { prompt: 'refactor the parser' })
    )
    expect(event?.payload).toMatchObject({
      state: 'working',
      agentType: 'zcode',
      prompt: 'refactor the parser'
    })
  })

  it('reports working for an ordinary PreToolUse and names the tool', () => {
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('PreToolUse', toolFields('Bash', { command: 'pnpm test' }))
    )
    expect(event?.payload).toMatchObject({ state: 'working', agentType: 'zcode', toolName: 'Bash' })
  })

  it('reports waiting for PermissionRequest — ZCode only fires it with the card on screen', () => {
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('PermissionRequest', {
        ...toolFields('Bash', { command: 'rm -rf build' }),
        reason: 'Tool Bash requires approval',
        riskLevel: 'high'
      })
    )
    expect(event?.payload).toMatchObject({
      state: 'waiting',
      agentType: 'zcode',
      toolName: 'Bash'
    })
  })

  it('reports waiting for the AskUserQuestion tool and keeps its question card input', () => {
    const questions = [
      {
        question: 'Which database should we use?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'SQLite', description: 'Embedded' }
        ],
        multiSelect: false
      }
    ]
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('PreToolUse', toolFields('AskUserQuestion', { questions }))
    )
    expect(event?.payload).toMatchObject({ state: 'waiting', agentType: 'zcode' })
    // Why: the clients render this verbatim as a live question card.
    expect(JSON.parse(event?.payload.interactivePrompt ?? '{}')).toMatchObject({ questions })
  })

  it('returns to working after PostToolUse and after a tool failure', () => {
    for (const eventName of ['PostToolUse', 'PostToolUseFailure']) {
      const event = normalizeAndAccept(
        state,
        'zcode',
        zcodeEvent(eventName, toolFields('Bash', { command: 'pnpm test' }))
      )
      expect(event?.payload).toMatchObject({ state: 'working', agentType: 'zcode' })
    }
  })

  it('reports done on Stop and surfaces the final assistant message', () => {
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('Stop', {
        last_assistant_message: 'All tests pass.',
        stop_hook_active: false,
        responsePreview: 'All tests pass.'
      })
    )
    expect(event?.payload).toMatchObject({
      state: 'done',
      agentType: 'zcode',
      lastAssistantMessage: 'All tests pass.'
    })
  })

  it('marks an interrupted Stop so the row does not read as a clean finish', () => {
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('Stop', { is_interrupt: true, last_assistant_message: '' })
    )
    expect(event?.payload).toMatchObject({ state: 'done', interrupted: true })
  })

  it('ignores lifecycle events it does not model', () => {
    expect(normalizeAndAccept(state, 'zcode', zcodeEvent('SomethingElse'))).toBeNull()
  })

  it('attributes every event to zcode, never to claude, despite the compatible payload', () => {
    const event = normalizeAndAccept(
      state,
      'zcode',
      zcodeEvent('UserPromptSubmit', { prompt: 'hello' })
    )
    expect(event?.payload.agentType).toBe('zcode')
  })
})
