import { describe, expect, it } from 'vitest'
import type { NativeChatSubagentActivity } from './native-chat-activity'
import {
  nativeChatDismissSubagents,
  nativeChatReconcileDismissals,
  nativeChatVisibleDismissedSubagents,
  parseDismissedSubagentStatesJson
} from './native-chat-subagent-dismissals'

function agent(id: string, state: NativeChatSubagentActivity['state']): NativeChatSubagentActivity {
  return { id, label: id, state, activity: null }
}

const roster = [
  agent('run', 'working'),
  agent('bad', 'failed'),
  agent('lost', 'unverifiable'),
  agent('done', 'completed')
]

describe('nativeChatVisibleDismissedSubagents', () => {
  it('hides a child only while its state still matches the dismissal', () => {
    const dismissed = { bad: 'failed' as const, lost: 'unverifiable' as const }
    expect(nativeChatVisibleDismissedSubagents(roster, dismissed).map((entry) => entry.id)).toEqual(
      ['run', 'done']
    )
    expect(
      nativeChatVisibleDismissedSubagents(
        [agent('bad', 'working'), agent('lost', 'failed')],
        dismissed
      ).map((entry) => entry.id)
    ).toEqual(['bad', 'lost'])
  })
})

describe('nativeChatDismissSubagents', () => {
  it('records failed and unverifiable children and leaves a running child alone', () => {
    expect(nativeChatDismissSubagents({}, roster)).toEqual({
      bad: 'failed',
      lost: 'unverifiable'
    })
  })
})

describe('nativeChatReconcileDismissals', () => {
  it('drops a dismissal once the child reports a different state', () => {
    const dismissed = {
      bad: 'failed' as const,
      lost: 'unverifiable' as const,
      gone: 'failed' as const
    }
    expect(
      nativeChatReconcileDismissals(dismissed, [
        agent('bad', 'working'),
        agent('lost', 'unverifiable')
      ])
    ).toEqual({
      lost: 'unverifiable',
      gone: 'failed'
    })
    expect(nativeChatReconcileDismissals(dismissed, [agent('lost', 'unverifiable')])).toBe(
      dismissed
    )
  })
})

describe('parseDismissedSubagentStatesJson', () => {
  it('keeps known states and drops malformed records', () => {
    expect(
      parseDismissedSubagentStatesJson('{"bad":"failed","run":"working","nope":"nope"}')
    ).toEqual({
      bad: 'failed',
      run: 'working'
    })
    expect(parseDismissedSubagentStatesJson('{"/root/child":"failed","":"failed"}')).toEqual({
      '/root/child': 'failed'
    })
    expect(parseDismissedSubagentStatesJson('not json')).toEqual({})
    expect(parseDismissedSubagentStatesJson(null)).toEqual({})
  })
})
