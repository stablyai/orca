import { describe, expect, it } from 'vitest'
import { normalizeHookPayload, createHookListenerState } from './agent-hook-listener'
import type { HookListenerState } from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

function state(): HookListenerState {
  return createHookListenerState()
}

/** Build a synthetic crush SSE body the way Orca's SSE bridge does.
 *  Mirrors AgentHookServer.submitSyntheticHookEvent. */
function crushBody(args: { hookEventName: string; hookPayload: unknown }): Record<string, unknown> {
  return {
    paneKey: PANE_KEY,
    hook_event_name: args.hookEventName,
    payload: args.hookPayload
  }
}

describe('normalizeHookPayload — crush (charmbracelet/crush) SSE bridge', () => {
  it('treats a role=user message as a new turn and captures the prompt', () => {
    const normalized = normalizeHookPayload(
      state(),
      'crush',
      crushBody({
        hookEventName: 'message:user',
        hookPayload: {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', data: { text: 'refactor the parser' } }]
        }
      }),
      'production'
    )
    expect(normalized).not.toBeNull()
    expect(normalized!.payload.state).toBe('working')
    expect(normalized!.payload.agentType).toBe('crush')
    expect(normalized!.payload.prompt).toBe('refactor the parser')
  })

  it('maps an assistant message with an unfinished tool_call to working + tool fields', () => {
    const s = state()
    // Why: seed the prompt so it survives a tool-only update (assistant turns don't reset prompt).
    normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:user',
        hookPayload: {
          role: 'user',
          parts: [{ type: 'text', data: { text: 'do something' } }]
        }
      }),
      'production'
    )
    const normalized = normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:assistant',
        hookPayload: {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              data: { id: 'call-1', name: 'bash', input: 'ls -la', finished: false }
            }
          ]
        }
      }),
      'production'
    )
    expect(normalized).not.toBeNull()
    expect(normalized!.payload.state).toBe('working')
    expect(normalized!.payload.toolName).toBe('bash')
    expect(normalized!.payload.toolInput).toBe('ls -la')
    // Why: prompt persists from the previous user message — assistant turns don't reset.
    expect(normalized!.payload.prompt).toBe('do something')
  })

  it('skips finished tool_calls and surfaces the latest unfinished one as active', () => {
    const s = state()
    normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:user',
        hookPayload: { role: 'user', parts: [{ type: 'text', data: { text: 'multi-step' } }] }
      }),
      'production'
    )
    const normalized = normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:assistant',
        hookPayload: {
          role: 'assistant',
          parts: [
            // Why: an earlier finished tool_call must NOT be reported as active.
            {
              type: 'tool_call',
              data: { id: 'call-stale', name: 'grep', input: 'foo', finished: true }
            },
            {
              type: 'tool_call',
              data: { id: 'call-live', name: 'bash', input: 'ls -la', finished: false }
            }
          ]
        }
      }),
      'production'
    )
    expect(normalized!.payload.state).toBe('working')
    expect(normalized!.payload.toolName).toBe('bash')
    expect(normalized!.payload.toolInput).toBe('ls -la')
  })

  it('reports no active tool when every tool_call in an assistant message is finished', () => {
    const s = state()
    normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:user',
        hookPayload: { role: 'user', parts: [{ type: 'text', data: { text: 'done-step' } }] }
      }),
      'production'
    )
    const normalized = normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:assistant',
        hookPayload: {
          role: 'assistant',
          parts: [
            { type: 'tool_call', data: { id: 'c1', name: 'bash', input: 'pwd', finished: true } }
          ]
        }
      }),
      'production'
    )
    expect(normalized!.payload.state).toBe('working')
    expect(normalized!.payload.toolName).toBeUndefined()
  })

  it('maps a permission_request to blocked with the requesting tool', () => {
    const s = state()
    normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:user',
        hookPayload: { role: 'user', parts: [{ type: 'text', data: { text: 'write a file' } }] }
      }),
      'production'
    )
    const normalized = normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'permission_request',
        hookPayload: {
          id: 'p1',
          tool_name: 'write',
          path: '/repo/foo.txt',
          params: { file_path: '/repo/foo.txt' }
        }
      }),
      'production'
    )
    expect(normalized!.payload.state).toBe('blocked')
    expect(normalized!.payload.toolName).toBe('write')
  })

  it('maps run_complete to done with the final assistant text', () => {
    const s = state()
    normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'message:user',
        hookPayload: { role: 'user', parts: [{ type: 'text', data: { text: 'hello' } }] }
      }),
      'production'
    )
    const normalized = normalizeHookPayload(
      s,
      'crush',
      crushBody({
        hookEventName: 'run_complete',
        hookPayload: {
          session_id: 's1',
          run_id: 'r1',
          message_id: 'm1',
          text: 'hi there',
          cancelled: false
        }
      }),
      'production'
    )
    expect(normalized!.payload.state).toBe('done')
    expect(normalized!.payload.lastAssistantMessage).toBe('hi there')
    expect(normalized!.payload.interrupted).toBeUndefined()
  })

  it('sets interrupted when run_complete carries cancelled=true', () => {
    const normalized = normalizeHookPayload(
      state(),
      'crush',
      crushBody({
        hookEventName: 'run_complete',
        hookPayload: { session_id: 's1', message_id: 'm1', cancelled: true }
      }),
      'production'
    )
    expect(normalized!.payload.state).toBe('done')
    expect(normalized!.payload.interrupted).toBe(true)
  })

  it('maps an agent_event with type=response to done', () => {
    const normalized = normalizeHookPayload(
      state(),
      'crush',
      crushBody({
        hookEventName: 'agent_event',
        hookPayload: { type: 'response', session_id: 's1' }
      }),
      'production'
    )
    expect(normalized!.payload.state).toBe('done')
  })

  it('maps an agent_event with type=error to done with the error as lastAssistantMessage', () => {
    const normalized = normalizeHookPayload(
      state(),
      'crush',
      crushBody({
        hookEventName: 'agent_event',
        hookPayload: { type: 'error', error: 'API 401' }
      }),
      'production'
    )
    expect(normalized!.payload.state).toBe('done')
    expect(normalized!.payload.lastAssistantMessage).toBe('API 401')
  })

  it('ignores agent_event with an unknown inner type', () => {
    const normalized = normalizeHookPayload(
      state(),
      'crush',
      crushBody({
        hookEventName: 'agent_event',
        hookPayload: { type: 'unknown-event' }
      }),
      'production'
    )
    expect(normalized).toBeNull()
  })

  it('returns null for a non-crush SSE type (e.g. session)', () => {
    const normalized = normalizeHookPayload(
      state(),
      'crush',
      crushBody({
        hookEventName: 'session',
        hookPayload: { id: 's1', title: 'New session' }
      }),
      'production'
    )
    expect(normalized).toBeNull()
  })
})
