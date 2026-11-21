import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../agent-status/contracts/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../agent-session/view/structured-agent-session-projection'
import { botGroupStatus } from './bot-group-status'

const group = {
  members: [
    { botId: 'bot-1', sessionId: 'bot-group-member-1' },
    { botId: 'bot-2', sessionId: 'bot-group-member-2' }
  ]
}

function entry(sessionId: string, over: Partial<AgentStatusEntry>): [string, AgentStatusEntry] {
  const tabId = structuredAgentSessionTabId(sessionId)
  const paneKey = structuredAgentSessionPaneKey(tabId, sessionId)
  return [
    paneKey,
    {
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      structuredHostOwned: true,
      paneKey,
      tabId,
      stateHistory: [],
      ...over
    }
  ]
}

describe('botGroupStatus', () => {
  it("shows needs-you for one member's unconfirmed end while another works", () => {
    const statuses = new Map([
      entry('bot-group-member-1', {
        state: 'done',
        mainAgent: { state: 'done', outcome: 'unconfirmed', stateStartedAt: 1 }
      }),
      entry('bot-group-member-2', { state: 'working' })
    ])
    expect(botGroupStatus(group, statuses, 2)).toBe('permission')
  })

  it("shows needs-you for one member's failure while another monitors", () => {
    const statuses = new Map([
      entry('bot-group-member-1', {
        state: 'done',
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 }
      }),
      entry('bot-group-member-2', { state: 'working', workingMode: 'monitoring' })
    ])
    expect(botGroupStatus(group, statuses, 2)).toBe('permission')
  })

  it('counts only room member turns and clears after a clean finish', () => {
    expect(
      botGroupStatus(group, new Map([entry('home-session', {}), entry('worker-session', {})]), 2)
    ).toBeNull()
    expect(botGroupStatus(group, new Map([entry('bot-group-member-2', {})]), 2)).toBe('working')
    expect(
      botGroupStatus(
        group,
        new Map([
          entry('bot-group-member-1', {
            state: 'done',
            mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 1 }
          })
        ]),
        2
      )
    ).toBeNull()
  })
})

describe('botGroupStatus with threads', () => {
  const threaded = {
    ...group,
    threads: [
      {
        id: 'bot-group-thread-1',
        createdAt: 1,
        members: [{ botId: 'bot-1', sessionId: 'bot-group-member-t1' }]
      }
    ]
  }

  it("includes thread work and lets the thread's approval wait take precedence", () => {
    const statuses = new Map([entry('bot-group-member-t1', { state: 'working' })])
    expect(botGroupStatus(threaded, statuses, 2)).toBe('working')

    statuses.set(...entry('bot-group-member-1', { state: 'working' }))
    statuses.set(...entry('bot-group-member-t1', { state: 'blocked' }))
    expect(botGroupStatus(threaded, statuses, 2)).toBe('permission')
  })
})
