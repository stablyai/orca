import { describe, expect, it } from 'vitest'
import {
  botWorkerWorkspaceStatus,
  botWorkspaceLineAgent,
  countLiveBotWorkspaces,
  rollUpBotStatus
} from './bot-sidebar-workspaces'

describe('countLiveBotWorkspaces', () => {
  it('counts needs-you, working (monitoring too) and failed, and nothing else', () => {
    expect(
      countLiveBotWorkspaces(['permission', 'working', 'monitoring', 'failed', 'done', 'inactive'])
    ).toEqual({ permission: 1, working: 2, failed: 1 })
  })
})

describe('botWorkerWorkspaceStatus', () => {
  // A stale worker row lets its title ("Claude subagent permission prompts ...") read as a prompt.
  it('counts a worker as needing you only when one of its agents asks', () => {
    expect(
      countLiveBotWorkspaces([
        botWorkerWorkspaceStatus('permission', false),
        botWorkerWorkspaceStatus('permission', true),
        botWorkerWorkspaceStatus('working', false)
      ])
    ).toEqual({ permission: 1, working: 1, failed: 0 })
  })
})

describe('rollUpBotStatus', () => {
  it('takes needs-you over working over the bot itself', () => {
    expect(rollUpBotStatus('working', ['done', 'permission'])).toBe('permission')
    expect(rollUpBotStatus('active', ['done', 'monitoring'])).toBe('monitoring')
    expect(rollUpBotStatus('active', ['done', 'failed'])).toBe('active')
  })
})

describe('botWorkspaceLineAgent', () => {
  const agent = (agentType: string | null, state = 'working', subagent = false) => ({
    agentType,
    state,
    subagent
  })

  it('shows a logo per kind for two kinds, however many of each', () => {
    expect(
      botWorkspaceLineAgent([agent('codex'), agent('claude'), agent('claude'), agent('codex')])
    ).toEqual({ agentTypes: ['codex', 'claude'], others: 0, othersNeedYou: false })
  })

  it('shows the two most-run kinds and counts the agents of the rest', () => {
    expect(
      botWorkspaceLineAgent([
        agent('gemini'),
        agent('claude'),
        agent('codex'),
        agent('claude'),
        agent('codex'),
        agent('grok', 'waiting'),
        agent(null),
        agent('claude', 'working', true)
      ])
    ).toEqual({ agentTypes: ['claude', 'codex'], others: 3, othersNeedYou: true })
  })

  it('leaves +N plain when only a shown kind waits on the owner', () => {
    expect(
      botWorkspaceLineAgent([agent('claude', 'blocked'), agent('codex'), agent('gemini')])
    ).toEqual({ agentTypes: ['claude', 'codex'], others: 1, othersNeedYou: false })
  })

  it('shows the unknown mark when no agent is identified, and nothing without one of its own', () => {
    expect(botWorkspaceLineAgent([agent(null, 'waiting')])).toEqual({
      agentTypes: ['unknown'],
      others: 0,
      othersNeedYou: false
    })
    expect(botWorkspaceLineAgent([agent('claude', 'working', true)])).toBeNull()
  })
})
