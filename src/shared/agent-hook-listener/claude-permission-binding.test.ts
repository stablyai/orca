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

  it('forwards every batch’s owner-scoped calls for the receiver to judge, with a row even without a lead', () => {
    const h = harness()
    h.pre('T', read(0))
    h.ask(read(0))
    expect(h.batch(['T'])).toMatchObject({
      hookEventName: 'PostToolBatch',
      claudeBatchSettledRequests: [{ toolUseId: 'T' }],
      payload: { state: 'working', mainAgent: { state: 'working' } }
    })
    h.pre('U', read(1))
    h.pre('V', read(1))
    h.ask(read(1))
    // This host has no bound request here, but a receiver might still hold one; it decides.
    expect(h.batch(['U', 'V'])?.claudeBatchSettledRequests).toEqual([
      { toolUseId: 'U' },
      { toolUseId: 'V' }
    ])

    // A child's own batch restores the lead its request displaced.
    h.send('SubagentStart', child)
    h.pre('C', read(2), child)
    h.ask(read(2), child)
    expect(h.batch(['C'], child)).toMatchObject({
      toolAgentId: child.agent_id,
      claudeBatchSettledRequests: [
        { toolUseId: 'C', toolAgentId: child.agent_id, toolAgentType: child.agent_type }
      ],
      payload: { state: 'working' }
    })

    // A restarted host after an unrelated hook still forwards every call, the 20th included.
    const restarted = harness({ cold: true })
    restarted.send('Notification', { notification_type: 'permission_prompt' })
    const ids = Array.from({ length: 20 }, (_, i) => `call-${i}`)
    expect(restarted.batch(ids)).toMatchObject({
      payload: { state: 'working' },
      claudeBatchSettledRequests: ids.map((toolUseId) => ({ toolUseId }))
    })
  })

  it('keeps retained records and retirement work independent of completed history (N vs 10N), linear in current work, and bounded when saturated', () => {
    // Test-side counters only: every element production code reads from these maps, sets and arrays.
    const visits = { count: 0 }
    const counted = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(object, property) {
          const value: unknown = Reflect.get(object, property, object)
          if (typeof value !== 'function') {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
              visits.count++
            }
            return value
          }
          if (property === 'get' || property === 'has') {
            return (key: unknown) => {
              visits.count++
              return value.call(object, key)
            }
          }
          if (
            property === Symbol.iterator ||
            ['entries', 'keys', 'values'].includes(String(property))
          ) {
            return function* () {
              for (const item of value.call(object)) {
                visits.count++
                yield item
              }
            }
          }
          return value.bind(object)
        }
      })
    const instrument = (h: ReturnType<typeof harness>) => {
      const table = h.inFlight()
      if (!table) {
        throw new Error('no in-flight table')
      }
      table.owners = counted(table.owners)
      table.lossy = counted(table.lossy)
      const roster = h.state.claudeSubagentRosterByPaneKey.get(pane)
      if (roster) {
        h.state.claudeSubagentRosterByPaneKey.set(pane, counted(roster))
      }
      visits.count = 0
    }
    const liveWork = (h: ReturnType<typeof harness>, children: number) => {
      const ids = Array.from({ length: children }, (_, i) => `child-${i}`)
      for (const id of ids) {
        h.send('SubagentStart', { agent_id: id, agent_type: 'general-purpose' })
        h.pre(`${id}-call`, read(1), { agent_id: id })
      }
      instrument(h)
      h.pre('root-call', read(0))
      h.ask(read(0))
      h.batch(['root-call'])
      const tasks = ids.map((id) => ({ id, type: 'subagent', status: 'running' }))
      h.send('Stop', { background_tasks: counted(tasks) })
      return visits.count
    }

    // Completed hook-agent owners never report an end; their settled calls must leave nothing behind.
    const afterHistory = [20, 200].map((owners) => {
      const h = harness()
      for (let i = 0; i < owners; i++) {
        const agent = { agent_id: `hook-agent-${i}` }
        h.pre(`call-${i}`, read(i), agent)
        h.send('PostToolUse', { ...read(i), tool_use_id: `call-${i}`, ...agent })
      }
      h.send('Stop', { background_tasks: [] })
      h.send('UserPromptSubmit', { prompt: 'Again' })
      const retained = { owners: h.inFlight()?.owners.size, lossy: h.inFlight()?.lossy.size }
      return { retained, visits: liveWork(h, 3) }
    })
    expect(afterHistory[0]).toEqual({
      retained: { owners: 0, lossy: 0 },
      visits: afterHistory[0].visits
    })
    expect(afterHistory[1]).toEqual(afterHistory[0])

    // Current roster and inventory: work grows with them, not faster.
    const [small, large] = [5, 50].map((children) => liveWork(harness(), children))
    expect(large).toBeGreaterThan(small)
    expect(large).toBeLessThanOrEqual(10 * small)

    // Saturated: many distinct owners that cannot be admitted leave bounded records and a lasting fallback.
    const h = harness()
    for (let call = 0; call < 256; call++) {
      h.pre(`root-${call}`, read(1000 + call))
    }
    for (let owner = 0; owner < 500; owner++) {
      h.pre(`lost-${owner}`, read(owner), { agent_id: `hook-agent-${owner}` })
    }
    expect({
      owners: h.inFlight()?.owners.size,
      lossy: h.inFlight()?.lossy.size,
      degraded: h.inFlight()?.degraded
    }).toEqual({ owners: 1, lossy: 64, degraded: true })
    h.send('Stop')
    h.send('UserPromptSubmit', { prompt: 'Again' })
    h.pre('fresh', read(0))
    // A root turn end does not cover the lost hook-agent calls, so binding stays off until the session ends.
    expect(h.ask(read(0))?.toolUseId).toBeUndefined()
    h.send('SessionStart', { source: 'clear' })
    h.send('UserPromptSubmit', { prompt: 'Cleared' })
    h.pre('after-clear', read(0))
    expect(h.ask(read(0))?.toolUseId).toBe('after-clear')
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
