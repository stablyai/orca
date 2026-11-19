import { describe, expect, it, vi } from 'vitest'
import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import {
  dispatchStructuredAgentSessionComposerCommand,
  type StructuredAgentSessionComposerOptions
} from './structured-agent-session-composer'
import { structuredSessionSlashCommands } from './structured-agent-session-slash-menu'

function chat(
  agent: AgentType,
  toggleRemoteControl?: () => Promise<boolean>
): StructuredAgentSessionComposerOptions {
  return {
    agent,
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true,
    ...(toggleRemoteControl ? { toggleRemoteControl } : {})
  }
}

describe('/remote-control in a chat', () => {
  it("is Orca's in a Claude chat, by its full name and as /rc", async () => {
    const toggle = vi.fn(async () => true)

    const outcomes = [
      await dispatchStructuredAgentSessionComposerCommand('/rc', chat('claude', toggle)),
      await dispatchStructuredAgentSessionComposerCommand('/remote-control', chat('claude', toggle))
    ]

    expect(outcomes).toEqual([
      { handled: true, accepted: true, error: null },
      { handled: true, accepted: true, error: null }
    ])
    expect(toggle).toHaveBeenCalledTimes(2)
  })

  it('refuses a name after it, and says so where the host cannot change it', async () => {
    const toggle = vi.fn(async () => true)

    const named = await dispatchStructuredAgentSessionComposerCommand(
      '/rc my phone',
      chat('claude', toggle)
    )
    const olderHost = await dispatchStructuredAgentSessionComposerCommand('/rc', chat('claude'))

    expect(named).toMatchObject({ handled: true, accepted: false, error: expect.any(String) })
    expect(olderHost).toMatchObject({
      handled: true,
      accepted: false,
      error: expect.any(String)
    })
    expect(toggle).not.toHaveBeenCalled()
  })

  it("leaves another agent's /rc to that agent", async () => {
    const toggle = vi.fn(async () => true)

    const outcome = await dispatchStructuredAgentSessionComposerCommand(
      '/rc',
      chat('codex', toggle)
    )

    expect(outcome).toEqual({ handled: false, accepted: false, error: null })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('is offered in the / menu only where the host saves the choice', () => {
    const offered = (remoteControl: boolean) =>
      structuredSessionSlashCommands('claude', [], [], false, false, false, remoteControl)
        .map(({ name }) => name)
        .filter((name) => name === 'rc' || name === 'remote-control')

    expect(offered(true)).toEqual(['remote-control', 'rc'])
    expect(offered(false)).toEqual([])
  })
})
