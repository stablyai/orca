import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../listener-state'
import { resolveHookSource } from '../source-routing'
import { normalizeHookPayload } from './normalize-hook-payload'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('Trae hook route', () => {
  it('routes /hook/trae to the trae source', () => {
    expect(resolveHookSource('/hook/trae')).toBe('trae')
  })

  it('stamps a session_id post as a done placeholder with providerSession', () => {
    const event = normalizeHookPayload(
      createHookListenerState(),
      'trae',
      {
        paneKey: PANE_KEY,
        worktreeId: 'wt',
        payload: {
          hook_event_name: 'session_report',
          session_id: 'trae-session-1'
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.connectionId).toBeNull()
    expect(event!.providerSession).toEqual({ key: 'session_id', id: 'trae-session-1' })
    expect(event!.providerSessionOnly).toBeUndefined()
    expect(event!.payload).toMatchObject({
      state: 'done',
      prompt: '',
      agentType: 'trae'
    })
  })

  it('extracts providerSession from a camelCase sessionId and still emits done', () => {
    const event = normalizeHookPayload(
      createHookListenerState(),
      'trae',
      {
        paneKey: PANE_KEY,
        payload: { sessionId: 'trae-camel-id' }
      },
      'production'
    )
    expect(event?.providerSession).toEqual({ key: 'session_id', id: 'trae-camel-id' })
    expect(event?.payload.agentType).toBe('trae')
    expect(event?.payload.state).toBe('done')
  })
})
