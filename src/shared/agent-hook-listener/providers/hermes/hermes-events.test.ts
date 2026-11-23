import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeAndAccept } from '../../normalization/agent-hook-listener-test-harness'

// Shapes follow Orca's managed Hermes plugin: it forwards no platform on tool hooks or on_session_end.
function event(
  name: string,
  sessionId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { hook_event_name: name, cwd: '/tmp/ws', session_id: sessionId, ...extra }
}

function hermesListener() {
  const state = createHookListenerState()
  return (payload: Record<string, unknown>) =>
    normalizeAndAccept(state, 'hermes', payload)?.payload ?? null
}

const root = { platform: 'cli' }
const child = { platform: 'subagent' }

describe('normalizeHermesEvent', () => {
  it('keeps delegate_task children from finishing or reopening the root turn', () => {
    const send = hermesListener()

    send(event('on_session_start', 'root', root))
    expect(send(event('pre_llm_call', 'root', { ...root, user_message: 'delegate' }))?.state).toBe(
      'working'
    )
    send(event('pre_tool_call', 'root', { tool_name: 'delegate_task' }))

    expect(send(event('on_session_start', 'child', child))).toBeNull()
    expect(send(event('pre_llm_call', 'child', { ...child, user_message: 'subtask' }))).toBeNull()
    expect(send(event('pre_tool_call', 'child', { tool_name: 'terminal' }))?.state).toBe('working')
    expect(send(event('post_llm_call', 'child', child))).toBeNull()
    expect(send(event('on_session_end', 'child'))).toBeNull()

    const rootDone = send(event('post_llm_call', 'root', root))
    expect(rootDone?.state).toBe('done')
    expect(rootDone?.prompt).toBe('delegate')

    // Background children outlive the root turn; their chatter must not reopen it.
    expect(send(event('pre_tool_call', 'child', { tool_name: 'terminal' }))).toBeNull()
    expect(send(event('pre_llm_call', 'child', child))).toBeNull()

    expect(send(event('pre_llm_call', 'root', { ...root, user_message: 'next' }))?.state).toBe(
      'working'
    )
    // A child remembered from the earlier turn still cannot end the newer one.
    expect(send(event('on_session_end', 'child'))).toBeNull()
    expect(send(event('post_llm_call', 'root', root))?.state).toBe('done')
    expect(send(event('on_session_end', 'root'))?.state).toBe('done')
  })

  it('keeps a child that ends before its first llm call from closing the root turn', () => {
    const send = hermesListener()

    send(event('pre_llm_call', 'root', { ...root, user_message: 'delegate' }))
    expect(send(event('on_session_start', 'child', child))).toBeNull()
    expect(send(event('on_session_end', 'child'))).toBeNull()

    expect(send(event('pre_tool_call', 'root', { tool_name: 'terminal' }))?.state).toBe('working')
    expect(send(event('post_llm_call', 'root', root))?.state).toBe('done')
  })
})
