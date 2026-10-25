import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  structuredAgentSessionGoalObjective,
  structuredSessionSlashCommands,
  structuredSlashCommands
} from './structured-agent-session-composer'

describe('structuredSlashCommands', () => {
  const hostController = {
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true,
    conversationCommands: ['clear', 'compact'] as const,
    runConversationCommand: async () => ({ accepted: true, error: null })
  }
  const REFUSAL = /is not available in chat sessions/

  // Menu and dispatcher must share policy or Codex-only tokens can reach Claude as literal prose instead of being handled.
  it.each(['codex', 'claude'] as const)(
    'offers %s only commands the host answers or the agent runs',
    async (agent) => {
      const offered = structuredSlashCommands(['clear', 'compact'], agent)
      expect(offered.length).toBeGreaterThan(0)
      for (const command of offered) {
        const outcome = await dispatchStructuredAgentSessionComposerCommand(`/${command.name}`, {
          ...hostController,
          agent
        })
        expect(outcome.error ?? '').not.toMatch(REFUSAL)
      }
    }
  )

  // Codex reports no catalog; fallback rows make its working text-driven commands discoverable.
  it('offers Codex the /goal the model acts on, described from the catalog', () => {
    const offered = structuredSlashCommands(['clear', 'compact'], 'codex')
    expect(offered.map((command) => command.name)).toEqual([
      'model',
      'effort',
      'clear',
      'compact',
      'goal'
    ])
    expect(offered.find((command) => command.name === 'goal')?.description).toBe(
      'Set or view the goal'
    )
    expect(isStructuredAgentSessionComposerCommand('/goal', 'codex')).toBe(false)
  })

  it('adds nothing for an agent whose own harness expands its commands', () => {
    expect(structuredSlashCommands(['clear', 'compact'], 'claude').map((c) => c.name)).toEqual([
      'model',
      'effort',
      'clear',
      'compact'
    ])
  })

  it('offers only the commands a chat session can carry out', () => {
    expect(structuredSlashCommands().map((command) => command.name)).toEqual(['model', 'effort'])
  })
  it('adds only implemented host-supported conversation commands', () => {
    expect(structuredSlashCommands(['clear', 'compact']).map((command) => command.name)).toEqual([
      'model',
      'effort',
      'clear',
      'compact'
    ])
    expect(structuredSlashCommands(['compact']).map((command) => command.name)).toEqual([
      'model',
      'effort',
      'compact'
    ])
  })
})

describe('structuredSessionSlashCommands', () => {
  const names = (commands: readonly { name: string }[]) => commands.map(({ name }) => name)

  // Reported Pi/ACP commands must not hide the host-owned commands.
  it("keeps the host's commands first once the session reports its own", () => {
    const reported = [
      { name: 'llama', kind: 'command' as const },
      { name: 'mcp', kind: 'command' as const },
      { name: 'skill:caveman', kind: 'skill' as const }
    ]
    expect(names(structuredSessionSlashCommands('pi', ['clear', 'compact'], undefined))).toEqual(
      names(structuredSlashCommands(['clear', 'compact'], 'pi'))
    )
    expect(names(structuredSessionSlashCommands('pi', ['clear', 'compact'], reported))).toEqual([
      'model',
      'effort',
      'clear',
      'compact',
      'llama',
      'mcp'
    ])
  })

  it("offers the host's row in place of an agent command of the same name", () => {
    const offered = structuredSessionSlashCommands(
      'opencode',
      ['clear', 'compact'],
      [{ name: 'compact', kind: 'command', description: 'compact the session' }]
    )
    expect(offered.filter(({ name }) => name === 'compact')).toEqual([
      { name: 'compact', description: 'Compact conversation context' }
    ])
  })
})

describe('isStructuredAgentSessionComposerCommand', () => {
  // Claim typed TUI-only commands even when hidden from the menu, so they do not reach the model as prose.
  it.each([
    ['codex', 'vim'],
    ['codex', 'clear'],
    ['claude', 'compact'],
    ['claude', 'clear']
  ] as const)('claims the unoffered %s command /%s', (agent, name) => {
    expect(isStructuredAgentSessionComposerCommand(`/${name}`, agent)).toBe(true)
  })

  it('leaves an unknown token to the chat path', () => {
    expect(isStructuredAgentSessionComposerCommand('/my-skill', 'claude')).toBe(false)
  })
})

describe('dispatchStructuredAgentSessionComposerCommand', () => {
  const controller = {
    agent: 'codex' as const,
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true
  }

  it('names what does work when a TUI-only command is typed', async () => {
    const outcome = await dispatchStructuredAgentSessionComposerCommand('/vim', controller)
    expect(outcome.handled).toBe(true)
    expect(outcome.error).toBe(
      '/vim is not available in chat sessions. Use the slash menu to see available commands.'
    )
  })
  it.each(['claude', 'codex'] as const)(
    'handles %s conversation commands without message fallthrough',
    async (agent) => {
      const runConversationCommand = vi.fn(async () => ({ accepted: true, error: null }))
      for (const command of ['clear', 'compact'] as const) {
        const result = await dispatchStructuredAgentSessionComposerCommand(`/${command}`, {
          ...controller,
          agent,
          conversationCommands: ['clear', 'compact'],
          runConversationCommand
        })
        expect(result).toEqual({ handled: true, accepted: true, error: null })
        expect(runConversationCommand).toHaveBeenLastCalledWith(command)
      }
    }
  )
  it('retains a draft on unsupported hosts and rejects arguments before dispatch', async () => {
    expect(await dispatchStructuredAgentSessionComposerCommand('/clear', controller)).toMatchObject(
      { handled: true, accepted: false, error: '/clear is not supported by this chat host.' }
    )
    const runConversationCommand = vi.fn()
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/compact keep this', {
        ...controller,
        conversationCommands: ['compact'],
        runConversationCommand
      })
    ).toMatchObject({ handled: true, accepted: false })
    expect(runConversationCommand).not.toHaveBeenCalled()
  })
})

describe('agent-implemented commands pass through to the agent', () => {
  const controller = {
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true
  }
  const PASSED_THROUGH = { handled: false, accepted: false, error: null }

  // Claude’s harness handles these from message text; claiming them would wrongly refuse working commands.
  it.each(['init', 'review', 'help'] as const)(
    'sends /%s on to the Claude harness instead of refusing it',
    async (name) => {
      expect(isStructuredAgentSessionComposerCommand(`/${name}`, 'claude')).toBe(false)
      expect(
        await dispatchStructuredAgentSessionComposerCommand(`/${name}`, {
          ...controller,
          agent: 'claude'
        })
      ).toEqual(PASSED_THROUGH)
    }
  )

  it.each(['clear', 'compact', 'model', 'effort'] as const)(
    'still claims the host-owned /%s on Claude',
    async (name) => {
      expect(isStructuredAgentSessionComposerCommand(`/${name}`, 'claude')).toBe(true)
      expect(
        (
          await dispatchStructuredAgentSessionComposerCommand(`/${name}`, {
            ...controller,
            agent: 'claude'
          })
        ).handled
      ).toBe(true)
    }
  )

  // Codex app-server lacks a slash parser, but its model handles /goal through goal tools.
  it('passes /goal through on Codex, arguments and all', async () => {
    expect(isStructuredAgentSessionComposerCommand('/goal', 'codex')).toBe(false)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/goal ship the fix', {
        ...controller,
        agent: 'codex'
      })
    ).toEqual(PASSED_THROUGH)
  })

  it('sets the goal through the host where the host can, instead of sending prose', async () => {
    const setThreadGoalObjective = vi.fn(async () => true)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/goal  ship the fix ', {
        ...controller,
        agent: 'codex',
        setThreadGoalObjective
      })
    ).toEqual({ handled: true, accepted: true, error: null })
    expect(setThreadGoalObjective).toHaveBeenCalledWith('ship the fix')

    // A refused goal keeps the draft; the session error surface explains why.
    setThreadGoalObjective.mockResolvedValueOnce(false)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/goal ship the fix', {
        ...controller,
        agent: 'codex',
        setThreadGoalObjective
      })
    ).toEqual({ handled: true, accepted: false, error: null })
  })

  it('reads the objective a goal-mode draft names, with or without a typed /goal', () => {
    expect(structuredAgentSessionGoalObjective('  Ship the parser  ')).toBe('Ship the parser')
    expect(structuredAgentSessionGoalObjective('/goal  Ship the parser ')).toBe('Ship the parser')
    expect(structuredAgentSessionGoalObjective('/GOAL')).toBe('')
    // Goal mode treats non-goal commands as objective text.
    expect(structuredAgentSessionGoalObjective('/model gpt-5')).toBe('/model gpt-5')
  })

  it('asks for an objective when a goal-capable host gets a bare /goal', async () => {
    const setThreadGoalObjective = vi.fn(async () => true)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/goal', {
        ...controller,
        agent: 'codex',
        setThreadGoalObjective
      })
    ).toEqual({ handled: true, accepted: false, error: 'Describe the goal after /goal.' })
    expect(setThreadGoalObjective).not.toHaveBeenCalled()
  })

  it('keeps refusing a Codex command the model cannot carry out', async () => {
    expect(isStructuredAgentSessionComposerCommand('/permissions', 'codex')).toBe(true)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/permissions', {
        ...controller,
        agent: 'codex'
      })
    ).toMatchObject({
      handled: true,
      error:
        '/permissions is not available in chat sessions. Use the slash menu to see available commands.'
    })
  })
})
