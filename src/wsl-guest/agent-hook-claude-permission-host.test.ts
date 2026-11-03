import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../shared/stable-pane-id'
import type { AgentSubagentSnapshot } from '../shared/agent-status-types'
import {
  decideRelayClaudePermission,
  relayClaudeReplayProjection
} from './agent-hook-claude-permission-host'

const pane = makePaneKey('permission', '11111111-1111-4111-8111-111111111111')
const session = '11111111-1111-4111-8111-111111111111'
const read = (path: string) => ({ tool_name: 'Read', tool_input: { file_path: path } })

type Visits = { count: number }

/** Test-side counter of every element production code reads from a Map by lookup or iteration. */
class CountedMap<K, V> extends Map<K, V> {
  constructor(
    entries: Map<K, V>,
    private readonly visits: Visits
  ) {
    super(entries)
  }

  override get(key: K): V | undefined {
    this.visits.count++
    return super.get(key)
  }

  override has(key: K): boolean {
    this.visits.count++
    return super.has(key)
  }

  override *entries(): MapIterator<[K, V]> {
    for (const item of super.entries()) {
      this.visits.count++
      yield item
    }
  }

  override *keys(): MapIterator<K> {
    for (const item of super.keys()) {
      this.visits.count++
      yield item
    }
  }

  override *values(): MapIterator<V> {
    for (const item of super.values()) {
      this.visits.count++
      yield item
    }
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }
}

/** Test-side counter of every field production reads from one roster row. */
class CountedSubagent implements AgentSubagentSnapshot {
  constructor(
    private readonly row: AgentSubagentSnapshot,
    private readonly visits: Visits
  ) {}

  private read<F extends keyof AgentSubagentSnapshot>(field: F): AgentSubagentSnapshot[F] {
    this.visits.count++
    return this.row[field]
  }

  get id() {
    return this.read('id')
  }
  get state() {
    return this.read('state')
  }
  get startedAt() {
    return this.read('startedAt')
  }
  get agentType() {
    return this.read('agentType')
  }
  get model() {
    return this.read('model')
  }
  get description() {
    return this.read('description')
  }
}

/** Test-side counter of every row and field production reads from a roster. */
function countedRoster(
  rows: AgentSubagentSnapshot[] | undefined,
  visits: Visits
): AgentSubagentSnapshot[] | undefined {
  if (!rows) {
    return rows
  }
  const counted: AgentSubagentSnapshot[] = []
  rows.forEach((row, index) => {
    const element = new CountedSubagent(row, visits)
    Object.defineProperty(counted, index, {
      enumerable: true,
      get: () => {
        visits.count++
        return element
      }
    })
  })
  return counted
}

describe('relay execution-host permission state', () => {
  it('keeps one represented request and constant work however many silent helpers came before (N vs 10N)', () => {
    const measured = [50, 500].map((helpers) => {
      const state = createHookListenerState()
      let cached: ReturnType<typeof normalizeHookPayload> = null
      const send = (hook_event_name: string, fields: Record<string, unknown> = {}) => {
        const event = normalizeHookPayload(
          state,
          'claude',
          { paneKey: pane, payload: { session_id: session, hook_event_name, ...fields } },
          'production'
        )
        if (!event) {
          return undefined
        }
        const decision = decideRelayClaudePermission(state, cached ?? undefined, event, false)
        if (decision.kind === 'publish') {
          cached = decision.event
        }
        return decision
      }
      send('SessionStart', { source: 'startup' })
      send('UserPromptSubmit', { prompt: 'Read the notes' })
      // Helpers whose calls never settle and who never report an end leave nothing for later requests.
      for (let i = 0; i < helpers; i++) {
        send('PreToolUse', { ...read(`/h${i}`), tool_use_id: `h${i}`, agent_id: `hook-agent-${i}` })
      }
      const visits = { count: 0 }
      state.claudePermissionRequestByPaneKey = new CountedMap(
        state.claudePermissionRequestByPaneKey,
        visits
      )
      state.claudeLeadStateByPaneKey = new CountedMap(state.claudeLeadStateByPaneKey, visits)
      state.claudeSubagentRosterByPaneKey = new CountedMap(
        state.claudeSubagentRosterByPaneKey,
        visits
      )
      send('PreToolUse', { ...read('/t'), tool_use_id: 'T' })
      send('PermissionRequest', read('/t'))
      const released = send('PostToolBatch', { tool_calls: [{ ...read('/t'), tool_use_id: 'T' }] })
      return {
        retained: state.claudePermissionRequestByPaneKey.size,
        released: released?.kind === 'publish' && released.event.payload.state === 'working',
        visits: visits.count
      }
    })
    expect(measured[0]).toMatchObject({ retained: 1, released: true })
    expect(measured[1]).toEqual(measured[0])
  })

  it("compares a held request's roster in work linear in the rosters, and keeps no retired roster (N vs 10N)", () => {
    const id = (i: number) => `c${String(i).padStart(4, '0')}`
    const measured = [50, 500].map((children) => {
      const state = createHookListenerState()
      // The relay's latest published row, held in an object since only the closures below assign it.
      const published: { event: ReturnType<typeof normalizeHookPayload> } = { event: null }
      const normalize = (hook_event_name: string, fields: Record<string, unknown> = {}) =>
        normalizeHookPayload(
          state,
          'claude',
          { paneKey: pane, payload: { session_id: session, hook_event_name, ...fields } },
          'production'
        )
      const decide = (event: NonNullable<ReturnType<typeof normalize>>) => {
        const decision = decideRelayClaudePermission(
          state,
          published.event ?? undefined,
          event,
          false
        )
        if (decision.kind === 'publish') {
          published.event = decision.event
        }
        return decision
      }
      const send = (hook_event_name: string, fields: Record<string, unknown> = {}) => {
        const event = normalize(hook_event_name, fields)
        return event ? decide(event) : undefined
      }
      const request = () => state.claudePermissionRequestByPaneKey.get(pane)
      // One trigger's comparison work: the roster is materialized and sorted before counting starts.
      const measure = (hook_event_name: string, fields: Record<string, unknown>) => {
        const event = normalize(hook_event_name, fields)!
        const held = request()!
        const previous = held.payload.subagents
        const next = event.payload.subagents
        // Each observation normalizes its own snapshot, so equal content is never a shared list.
        expect(next !== undefined && next === previous).toBe(false)
        const visits = { count: 0 }
        const countedPrevious = countedRoster(previous, visits)
        const countedNext = countedRoster(next, visits)
        held.payload.subagents = countedPrevious
        event.payload.subagents = countedNext
        const decision = decide(event)
        // Restore plain rosters wherever the counted ones landed, before any assertion reads them.
        for (const row of [held, request()!, event, published.event!]) {
          if (row.payload.subagents === countedPrevious) {
            row.payload.subagents = previous
          } else if (row.payload.subagents === countedNext) {
            row.payload.subagents = next
          }
        }
        expect(decision).toMatchObject({
          kind: 'publish',
          event: { claudePermission: { held: true } }
        })
        expect(request()).toMatchObject({
          hookEventName: 'PermissionRequest',
          claudeRequest: held.claudeRequest,
          payload: { state: 'waiting', toolName: 'Read' }
        })
        return { visits: visits.count, population: (previous?.length ?? 0) + (next?.length ?? 0) }
      }
      send('SessionStart', { source: 'startup' })
      send('UserPromptSubmit', { prompt: 'Read the notes' })
      for (let i = 0; i < children; i++) {
        send('SubagentStart', { agent_id: id(i), agent_type: 'general-purpose' })
      }
      send('PreToolUse', { ...read('/a'), tool_use_id: 'A' })
      send('PermissionRequest', read('/a'))
      expect(request()?.payload.subagents).toHaveLength(children)
      const last = request()!.payload.subagents!.at(-1)!.id

      const equal = measure('SubagentStart', { agent_id: id(0), agent_type: 'general-purpose' })
      expect(request()?.payload.subagents).toHaveLength(children)
      const changed = measure('SubagentStart', { agent_id: last, agent_type: 'Explore' })
      expect(request()?.payload.subagents?.at(-1)).toMatchObject({ id: last, agentType: 'Explore' })
      const grown = measure('SubagentStart', { agent_id: 'c9999', agent_type: 'Explore' })
      expect(request()?.payload.subagents).toHaveLength(children + 1)

      for (const child of [...Array(children).keys()].map(id).concat('c9999')) {
        expect(send('SubagentStop', { agent_id: child })).toMatchObject({
          event: { claudePermission: { held: true } }
        })
      }
      // Nothing retired stays behind the held request, its forwarded row or its replay.
      expect(request()?.payload.subagents ?? []).toHaveLength(0)
      expect(published.event?.payload.subagents ?? []).toHaveLength(0)
      expect(relayClaudeReplayProjection(state, pane)?.row?.payload.subagents ?? []).toHaveLength(0)
      const retired = measure('SubagentStop', { agent_id: id(0) })

      const released = send('PostToolBatch', { tool_calls: [{ ...read('/a'), tool_use_id: 'A' }] })
      expect(released).toMatchObject({ kind: 'publish', event: { payload: { state: 'working' } } })
      expect(request()).toBeNull()
      return { equal, changed, grown, retired }
    })
    for (const { equal, changed, grown, retired } of measured) {
      // A full comparison reads every row of both rosters; a change on the last row is found there.
      expect(equal.visits).toBeGreaterThanOrEqual(equal.population)
      expect(changed.visits).toBeGreaterThanOrEqual(changed.population)
      for (const { visits, population } of [equal, changed, grown, retired]) {
        expect(visits).toBeLessThanOrEqual(8 * population + 16)
      }
      expect(retired).toEqual(measured[0].retired)
    }
  })
})
