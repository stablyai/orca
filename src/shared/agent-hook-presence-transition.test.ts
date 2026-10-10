import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { transitionHookPresence } from './agent-hook-presence-transition'
import { readAgentProcessPresence } from './agent-process-presence'

const NOW = 10_000_000
const OWNER_PROCESS = { pid: 4001, platform: 'linux' as const, startTime: 'boot:1' }

function event(
  agentType: string,
  fields: Partial<AgentHookEventPayload> = {},
  state: 'working' | 'done' = 'working'
): AgentHookEventPayload {
  return {
    paneKey: 'pane',
    connectionId: null,
    payload: { state, prompt: '', agentType },
    ...fields
  }
}

function session(id: string) {
  return { providerSession: { key: 'session_id' as const, id } }
}

const owner = event(
  'claude',
  { ...session('claude-a'), agentPresence: { agent: 'claude', session: 'claude-a' } },
  'done'
)

describe('transitionHookPresence', () => {
  it("ignores a producer's own-type markers, which a nested agent overwrites", () => {
    const own = event('codex', {
      nestedIn: [{ agent: 'codex', session: 'claude-a' }]
    })
    expect(transitionHookPresence(own, owner, NOW, NOW).kind).toBe('write')
    expect(transitionHookPresence(own, undefined, undefined, NOW)).toMatchObject({
      kind: 'write',
      event: { agentPresence: { agent: 'codex' } }
    })
  })

  it('never stores the nesting markers on the row', () => {
    const transition = transitionHookPresence(
      event('claude', { ...session('claude-a'), nestedIn: [{ agent: 'codex', session: 'x' }] }),
      owner,
      NOW,
      NOW
    )
    expect(transition.kind === 'write' && 'nestedIn' in transition.event).toBe(false)
  })

  it('makes a different-type producer a guest of a live owner and asks to check it', () => {
    const live = event('claude', {
      agentPresence: { agent: 'claude', process: OWNER_PROCESS, session: 'claude-a' }
    })
    expect(transitionHookPresence(event('codex', session('codex-x')), live, NOW, NOW)).toEqual({
      kind: 'skip',
      probe: OWNER_PROCESS
    })
  })

  it('holds and checks only a live unproven guest; proof and a guest exit need no check', () => {
    const live = event('claude', {
      agentPresence: { agent: 'claude', process: OWNER_PROCESS, session: 'claude-a' }
    })
    const nested = event('codex', { nestedIn: [{ agent: 'claude', session: 'claude-a' }] })
    expect(transitionHookPresence(nested, live, NOW, NOW)).toEqual({ kind: 'skip' })
    const guestExit = event('codex', {
      agentPresence: { agent: 'codex', process: { ...OWNER_PROCESS, pid: 4002 }, ended: true }
    })
    expect(transitionHookPresence(guestExit, live, NOW, NOW)).toEqual({ kind: 'skip' })
  })

  it("never carries a restarted process's predecessor model or session", () => {
    const previous = event('claude', {
      ...session('claude-a'),
      agentPresence: { agent: 'claude', process: OWNER_PROCESS, session: 'claude-a' },
      payload: { state: 'done', prompt: '', agentType: 'claude', model: 'opus' }
    })
    const restarted = event('claude', {
      agentPresence: { agent: 'claude', process: { ...OWNER_PROCESS, pid: 4002 } }
    })
    const transition = transitionHookPresence(restarted, previous, NOW, NOW)
    expect(transition.kind === 'write' && transition.event.payload.model).toBeUndefined()
    expect(transition.kind === 'write' && transition.event.providerSession).toBeUndefined()
  })

  it('bounds the sessions an owner remembers', () => {
    let row: AgentHookEventPayload = owner
    for (const id of ['b', 'c', 'd', 'e', 'f', 'g']) {
      const transition = transitionHookPresence(event('claude', session(id)), row, NOW, NOW)
      if (transition.kind !== 'write') {
        throw new Error('owner event was not written')
      }
      row = transition.event
    }
    expect(row.agentPresence).toEqual({
      agent: 'claude',
      session: 'g',
      heldSessions: ['f', 'e', 'd', 'c']
    })
    expect(readAgentProcessPresence(JSON.parse(JSON.stringify(row.agentPresence)))).toEqual(
      row.agentPresence
    )
  })

  it("carries the owner's model and session through its own sparse events", () => {
    const withModel = event('codex', {
      ...session('codex-x'),
      agentPresence: { agent: 'codex', session: 'codex-x' },
      payload: { state: 'working', prompt: '', agentType: 'codex', model: 'gpt-5.4' }
    })
    expect(
      transitionHookPresence(event('codex', { toolAgentId: 'child' }), withModel, NOW, NOW)
    ).toMatchObject({
      kind: 'write',
      event: { providerSession: { id: 'codex-x' }, payload: { model: 'gpt-5.4' } }
    })
  })
})
