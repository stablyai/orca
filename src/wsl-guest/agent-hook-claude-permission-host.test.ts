import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../shared/stable-pane-id'
import { decideRelayClaudePermission } from './agent-hook-claude-permission-host'

const pane = makePaneKey('permission', '11111111-1111-4111-8111-111111111111')
const session = '11111111-1111-4111-8111-111111111111'
const read = (path: string) => ({ tool_name: 'Read', tool_input: { file_path: path } })

/** Test-side counter of every element production code reads from a Map by lookup or iteration. */
function counted<K, V>(map: Map<K, V>, visits: { count: number }): Map<K, V> {
  return new Proxy(map, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') {
        return value
      }
      if (property === 'get' || property === 'has') {
        return (key: K) => {
          visits.count++
          return value.call(target, key)
        }
      }
      if (
        property === Symbol.iterator ||
        ['entries', 'keys', 'values'].includes(String(property))
      ) {
        return function* () {
          for (const item of value.call(target)) {
            visits.count++
            yield item
          }
        }
      }
      return value.bind(target)
    }
  })
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
      state.claudePermissionRequestByPaneKey = counted(
        state.claudePermissionRequestByPaneKey,
        visits
      )
      state.claudeLeadStateByPaneKey = counted(state.claudeLeadStateByPaneKey, visits)
      state.claudeSubagentRosterByPaneKey = counted(state.claudeSubagentRosterByPaneKey, visits)
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
})
