import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  structuredSessionSlashCommands,
  structuredSlashCommands
} from './structured-agent-session-composer'

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
    ).toEqual({ handled: true, accepted: false, error: 'Describe the goal after /goal.' })
    expect(setThreadGoalObjective).not.toHaveBeenCalled()
  })

  // OMP's ACP catalog advertises only commands it handles itself, e.g. /fast.
  it('passes a session-reported command on to the session that advertised it', async () => {
    const sessionCommands = [
      { name: 'fast', kind: 'command' },
      { name: 'compact', kind: 'command' }
    ] as const
    expect(isStructuredAgentSessionComposerCommand('/fast', 'omp')).toBe(true)
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
