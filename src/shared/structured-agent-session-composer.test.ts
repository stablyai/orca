import { queuedMessageEditAcceptsText } from './queued-message-edit-command'
import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  structuredSessionSlashCommands,
  structuredSlashCommands
} from './structured-agent-session-composer'

describe('side chat commands', () => {
  it.each(['compact', 'model', 'goal'])(
    'preserves multiline /%s message passthrough',
    async (name) => {
      const setOption = vi.fn(async () => true)
      const runConversationCommand = vi.fn(async () => ({ accepted: true, error: null }))
      const setThreadGoalObjective = vi.fn(async () => true)
      const text = `/${name} first line\nsecond line`
      expect(isStructuredAgentSessionComposerCommand(text, 'codex', undefined, true)).toBe(false)
      expect(
        await dispatchStructuredAgentSessionComposerCommand(text, {
          snapshot: [],
          invokeAction: async () => false,
          setOption,
          conversationCommands: ['compact'],
          runConversationCommand,
          setThreadGoalObjective
        })
      ).toEqual({ handled: false, accepted: false, error: null })
      expect(setOption).not.toHaveBeenCalled()
      expect(runConversationCommand).not.toHaveBeenCalled()
      expect(setThreadGoalObjective).not.toHaveBeenCalled()
    }
  )

  it('forwards the picked skill files with a side question', async () => {
    const skills = [{ name: 'review', path: '/picked/SKILL.md' }]
    const openSideChat = vi.fn(async () => true)
    await dispatchStructuredAgentSessionComposerCommand(
      '/btw use $review',
      {
        snapshot: [],
        invokeAction: async () => false,
        setOption: async () => false,
        openSideChat
      },
      skills
    )
    expect(openSideChat).toHaveBeenCalledExactlyOnceWith('use $review', skills)
  })

  it.each(['codex', 'claude', 'opencode', 'pi'] as const)(
    'uses declared support rather than %s agent names',
    async (agent) => {
      const openSideChat = vi.fn(async () => true)
      const controller = {
        agent,
        snapshot: [],
        invokeAction: async () => false,
        setOption: async () => false
      }
      expect(
        structuredSessionSlashCommands(agent, [], undefined).some(({ name }) => name === 'btw')
      ).toBe(false)
      expect(
        structuredSessionSlashCommands(agent, [], undefined, true).some(
          ({ name }) => name === 'btw'
        )
      ).toBe(true)
      expect(
        await dispatchStructuredAgentSessionComposerCommand(
          '/btw Why this approach?\nAnd this tradeoff?',
          {
            ...controller,
            openSideChat
          }
        )
      ).toEqual({
        handled: true,
        accepted: true,
        error: null
      })
      expect(openSideChat).toHaveBeenCalledWith('Why this approach?\nAnd this tradeoff?')
      await dispatchStructuredAgentSessionComposerCommand('/btw', { ...controller, openSideChat })
      expect(openSideChat).toHaveBeenLastCalledWith('')
      expect(openSideChat).toHaveBeenCalledTimes(2)
      expect(isStructuredAgentSessionComposerCommand('/btw question', agent)).toBe(false)
      expect(isStructuredAgentSessionComposerCommand('/btw question', agent, undefined, true)).toBe(
        true
      )
      expect(
        structuredSessionSlashCommands(
          agent,
          [],
          [{ name: 'btw', kind: 'command', description: 'Native side question' }]
        ).filter(({ name }) => name === 'btw')
      ).toEqual([{ name: 'btw', description: 'Native side question' }])
      expect(
        await dispatchStructuredAgentSessionComposerCommand('/btw question', controller)
      ).toEqual({ handled: false, accepted: false, error: null })
    }
  )
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

describe('dispatchStructuredAgentSessionComposerCommand', () => {
  const controller = {
    agent: 'codex' as const,
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true
  }
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

  it('asks for an objective when a goal-capable host gets a bare /goal', async () => {
    const setThreadGoalObjective = vi.fn(async () => true)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/goal', {
        ...controller,
        agent: 'codex',
        setThreadGoalObjective
      })
    ).toEqual({
      handled: true,
      accepted: false,
      error: 'Describe the goal after /goal.',
      errorCode: 'goalObjectiveMissing'
    })
    expect(setThreadGoalObjective).not.toHaveBeenCalled()
  })

  // OMP's ACP catalog advertises only commands it handles itself, e.g. /fast.
  it('passes a session-reported command on to the session that advertised it', async () => {
    const sessionCommands = [
      { name: 'fast', kind: 'command' },
      { name: 'compact', kind: 'command' }
    ] as const
    expect(isStructuredAgentSessionComposerCommand('/fast', 'omp')).toBe(false)
    expect(isStructuredAgentSessionComposerCommand('/fast', 'omp', sessionCommands)).toBe(false)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/fast status', {
        ...controller,
        agent: 'omp',
        sessionCommands
      })
    ).toEqual(PASSED_THROUGH)
    // Orca still runs its own commands even when the session reports them.
    expect(isStructuredAgentSessionComposerCommand('/compact', 'omp', sessionCommands)).toBe(true)
  })

  it('leaves provider text independent of the optional inventory', async () => {
    for (const sessionCommands of [
      undefined,
      [],
      [{ name: 'permissions', kind: 'command' as const }]
    ]) {
      expect(queuedMessageEditAcceptsText('/fast status', 'omp', sessionCommands)).toBe(true)
      expect(queuedMessageEditAcceptsText('/clear', 'omp', sessionCommands)).toBe(false)
      expect(
        isStructuredAgentSessionComposerCommand('/permissions', 'codex', sessionCommands)
      ).toBe(false)
      expect(
        await dispatchStructuredAgentSessionComposerCommand('/permissions', {
          ...controller,
          agent: 'codex',
          sessionCommands
        })
      ).toEqual(PASSED_THROUGH)
      expect(
        await dispatchStructuredAgentSessionComposerCommand('/fast status', {
          ...controller,
          agent: 'omp',
          sessionCommands
        })
      ).toEqual(PASSED_THROUGH)
    }
  })
})
