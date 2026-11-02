import { describe, expect, it } from 'vitest'
import captures from './__fixtures__/declined-permission-hooks.json'
import { normalizeHookPayload } from '../agent-hook-listener'
import { createHookListenerState } from './listener-state'
import { makePaneKey } from '../stable-pane-id'

const pane = makePaneKey('permission', '11111111-1111-4111-8111-111111111111')
const session = '11111111-1111-4111-8111-111111111111'
const child = { agent_id: 'child-a', agent_type: 'general-purpose' }
const read = (offset: number) => ({ tool_name: 'Read', tool_input: { file_path: '/x', offset } })

function harness({ cold = false } = {}) {
  const state = createHookListenerState()
  const send = (hook_event_name: string, fields: Record<string, unknown> = {}) =>
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: pane, payload: { session_id: session, hook_event_name, ...fields } },
      'production'
    )
  if (!cold) {
    send('SessionStart', { source: 'startup' })
    send('UserPromptSubmit', { prompt: 'Read the notes' })
  }
  const pre = (id: string, tool: Record<string, unknown>, owner = {}) =>
    send('PreToolUse', { ...tool, tool_use_id: id, ...owner })
  const ask = (tool: Record<string, unknown>, owner = {}) =>
    send('PermissionRequest', { ...tool, ...owner })
  const batch = (ids: string[], owner = {}) =>
    send('PostToolBatch', { tool_calls: ids.map((tool_use_id) => ({ tool_use_id })), ...owner })
  const inFlight = () => state.claudeInFlightByPaneKey.get(pane)
  return { state, send, pre, ask, batch, inFlight }
}

describe('Claude permission binding', () => {
  it('names a request by the one in-flight call with its whole input, whatever its key order', () => {
    const h = harness()
    h.pre('T', read(0))
    h.pre('U', read(100))
    // Both previews read "/x"; only the whole input tells the calls apart.
    const request = h.ask({ tool_name: 'Read', tool_input: { offset: 0, file_path: '/x' } })
    expect(request).toMatchObject({ toolUseId: 'T', payload: { state: 'waiting' } })
    expect(JSON.stringify(h.inFlight())).not.toContain('/x')
  })

  it('leaves main’s path unchanged when no call or several calls match', () => {
    const h = harness()
    h.pre('T', read(0))
    h.pre('U', read(0))
    expect(h.ask(read(0))?.toolUseId).toBeUndefined()
    // Another owner's equal call is not a candidate, nor is an input a hook rewrote.
    h.pre('C', read(5), child)
    expect(h.ask(read(5))?.toolUseId).toBeUndefined()
    expect(h.ask(read(7))?.toolUseId).toBeUndefined()
    h.pre('Q', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } })
    expect(
      h.ask({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } })?.toolUseId
    ).toBeUndefined()
    // A request the provider names keeps its own id.
    expect(h.ask({ ...read(9), tool_use_id: 'named' })?.toolUseId).toBe('named')
  })

  it('forgets calls at their own settlement and when their owner ends', () => {
    const h = harness()
    h.pre('T', read(0))
    h.send('PostToolUse', { ...read(0), tool_use_id: 'T' })
    expect(h.ask(read(0))?.toolUseId).toBeUndefined()
    h.pre('U', read(1))
    h.batch(['U'])
    h.pre('C', read(2), child)
    h.send('SubagentStop', child)
    h.pre('R', read(3))
    h.send('UserPromptSubmit', { prompt: 'Next' })
    expect(h.inFlight()?.size).toBe(0)

    // A complete background inventory proves a child ended as its own SubagentStop would.
    h.send('SubagentStart', child)
    h.pre('D', read(4), child)
    h.send('Stop', { background_tasks: [] })
    expect(h.inFlight()?.owners.get(child.agent_id)).toBeUndefined()
  })

  it('publishes a batch only when it settles the bound request, or when a cold host cannot know', () => {
    const h = harness()
    h.pre('T', read(0))
    h.ask(read(0))
    const released = h.batch(['T'])
    expect(released).toMatchObject({
      hookEventName: 'PostToolBatch',
      claudeSettledRequests: [{ toolUseId: 'T' }],
      payload: { state: 'working', mainAgent: { state: 'working' } }
    })
    h.pre('U', read(1))
    h.pre('V', read(1))
    h.ask(read(1))
    expect(h.batch(['U', 'V'])).toBeNull()

    // A child's own batch restores the lead its request displaced.
    h.send('SubagentStart', child)
    h.pre('C', read(2), child)
    h.ask(read(2), child)
    expect(h.batch(['C'], child)).toMatchObject({
      toolAgentId: child.agent_id,
      claudeSettledRequests: [{ toolUseId: 'C', toolAgentId: child.agent_id }],
      payload: { state: 'working' }
    })

    const cold = harness({ cold: true })
    const ids = Array.from({ length: 20 }, (_, i) => `cold-${i}`)
    expect(cold.batch(ids)?.claudeSettledRequests).toHaveLength(16)
  })

  it('keeps in-flight memory to live calls and falls back once an owner outgrows the bound (N vs 10N)', () => {
    for (const turns of [50, 500]) {
      const h = harness()
      for (let turn = 0; turn < turns; turn++) {
        h.pre(`call-${turn}`, read(turn))
        h.send('PostToolUse', { ...read(turn), tool_use_id: `call-${turn}` })
        h.batch([`call-${turn}`])
      }
      expect({ turns, size: h.inFlight()?.size, owners: h.inFlight()?.owners.size }).toEqual({
        turns,
        size: 0,
        owners: 1
      })
    }

    // Calls whose settlement never arrived: past the bound, a missed equal call could bind wrongly.
    const h = harness()
    for (let call = 0; call < 300; call++) {
      h.pre(`lost-${call}`, read(call))
    }
    expect(h.inFlight()?.size).toBe(256)
    expect(h.ask(read(0))?.toolUseId).toBeUndefined()
    h.send('Stop')
    h.send('UserPromptSubmit', { prompt: 'Again' })
    h.pre('fresh', read(0))
    expect(h.ask(read(0))?.toolUseId).toBe('fresh')
  })

  it('preserves the recorded Codex decline Interrupt and next-turn approval contract', () => {
    const state = createHookListenerState()
    let approvals = 0
    for (const raw of captures.codex) {
      const row = normalizeHookPayload(
        state,
        'codex',
        { paneKey: pane, payload: raw },
        'production'
      )
      expect(row?.claudeSettledRequests).toBeUndefined()
      if (raw.hook_event_name === 'Interrupt') {
        expect(row?.payload).toMatchObject({ state: 'done', interrupted: true })
      }
      if (raw.hook_event_name === 'PermissionRequest') {
        approvals++
        expect(row?.payload.state).toBe('waiting')
      }
      if (raw.hook_event_name === 'PostToolUse') {
        expect(row?.payload.state).toBe('working')
      }
    }
    expect(approvals).toBe(2)
    expect(state.claudeInFlightByPaneKey.size).toBe(0)
  })
})
