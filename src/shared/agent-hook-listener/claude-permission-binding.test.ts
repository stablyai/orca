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
      claudeBatchSettledRequests: [{ toolUseId: 'C' }],
      payload: { state: 'working' }
    })

    // A restarted host after an unrelated hook still forwards every valid call, position 257 included.
    const restarted = harness({ cold: true })
    restarted.send('Notification', { notification_type: 'permission_prompt' })
    const ids = Array.from({ length: 300 }, (_, i) => `call-${i}`)
    expect(restarted.batch(ids)).toMatchObject({
      payload: { state: 'working' },
      claudeBatchSettledRequests: ids.map((toolUseId) => ({ toolUseId }))
    })
  })

  it('keeps retained records and retirement work independent of completed history (N vs 10N) and linear in current and ended work', () => {
    // Test-side counters only: elements production code reads from the owner map, each owner's call map,
    // the loss set, the roster and the raw inventory array. Parsed task objects and the existing roster
    // fold's own comparisons are not proxied, so this is a lower bound on that fold, not an exhaustive count.
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
      for (const [owner, calls] of table.owners) {
        table.owners.set(owner, counted(calls))
      }
      table.owners = counted(table.owners)
      table.lossy = counted(table.lossy)
      const roster = h.state.claudeSubagentRosterByPaneKey.get(pane)
      if (roster) {
        h.state.claudeSubagentRosterByPaneKey.set(pane, counted(roster))
      }
      visits.count = 0
    }
    // N current children with live calls; the complete inventory keeps the even ones and ends the rest.
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
      const surviving = ids.filter((_, i) => i % 2 === 0)
      const tasks = surviving.map((id) => ({ id, type: 'subagent', status: 'running' }))
      h.send('Stop', { background_tasks: counted(tasks) })
      const owners = [...(h.inFlight()?.owners.keys() ?? [])].sort()
      expect(owners).toEqual([...surviving].sort())
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
      return { retained, visits: liveWork(h, 4) }
    })
    expect(afterHistory[0].retained).toEqual({ owners: 0, lossy: 0 })
    expect(afterHistory[1]).toEqual(afterHistory[0])

    // Ended and surviving children both grow tenfold; a retirement that rescanned every owner per ended
    // child would grow about a hundredfold here.
    const [small, large] = [10, 100].map((children) => liveWork(harness(), children))
    expect(large).toBeGreaterThan(small)
    expect(large).toBeLessThanOrEqual(10 * small + 20)
  })

  it('keeps loss with its owner: named overflow never unbinds a fully observed root, and leaves bounded records', () => {
    const h = harness()
    for (let call = 0; call < 256; call++) {
      h.pre(`helper-${call}`, read(1000 + call), { agent_id: `hook-agent-a${call}` })
    }
    for (let owner = 0; owner < 500; owner++) {
      h.pre(`lost-${owner}`, read(owner), { agent_id: `hook-agent-b${owner}` })
    }
    expect({
      owners: h.inFlight()?.owners.size,
      lossy: h.inFlight()?.lossy.size,
      namedOwnersDegraded: h.inFlight()?.namedOwnersDegraded
    }).toEqual({ owners: 256, lossy: 64, namedOwnersDegraded: true })
    // The root lost nothing, so its own whole-input evidence still names T.
    h.pre('T', read(0))
    h.pre('U', read(100))
    expect(h.ask(read(0))?.toolUseId).toBe('T')
    // A named owner after the overflow cannot be shown complete, so it takes main's unbound path.
    h.pre('C', read(5), child)
    expect(h.ask(read(5), child)?.toolUseId).toBeUndefined()
    // Only a covering end restores named binding: a root turn end does not, a session replacement does.
    h.send('Stop')
    h.send('UserPromptSubmit', { prompt: 'Again' })
    expect(h.inFlight()?.namedOwnersDegraded).toBe(true)
    h.send('SessionStart', { source: 'clear' })
    h.pre('C2', read(6), child)
    expect(h.ask(read(6), child)?.toolUseId).toBe('C2')
  })

  it('lets an older request’s batch settle it without resuming a lead a newer question or elicitation now owns', () => {
    const question = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which?' }] }
    }
    for (const newer of [
      (h: ReturnType<typeof harness>) => {
        h.send('PreToolUse', { ...question, tool_use_id: 'Q' })
        return h.send('PermissionRequest', question)
      },
      (h: ReturnType<typeof harness>) =>
        h.send('Elicitation', { mcp_server_name: 'server', message: 'Allow?', mode: 'form' })
    ]) {
      const h = harness()
      h.pre('A', read(0))
      expect(h.ask(read(0))?.toolUseId).toBe('A')
      expect(newer(h)?.payload).toMatchObject({ state: 'waiting', mainAgent: { state: 'waiting' } })
      // A's proof still goes out whole, but the lead keeps showing the newer dialog.
      expect(h.batch(['A'])).toMatchObject({
        claudeBatchSettledRequests: [{ toolUseId: 'A' }],
        payload: { state: 'waiting', mainAgent: { state: 'waiting' } }
      })
      expect(h.send('SubagentStart', child)?.payload).toMatchObject({ state: 'waiting' })
    }

    // Outside a turn, too: an idle pane's elicitation is not undone by an older request's batch.
    const idle = harness()
    idle.pre('A', read(0))
    idle.ask(read(0))
    idle.send('Stop')
    idle.send('Elicitation', { mcp_server_name: 'server', message: 'Allow?', mode: 'form' })
    expect(idle.batch(['A'])?.payload).toMatchObject({ state: 'waiting' })
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
