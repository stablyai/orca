import { queuedMessageEditAcceptsText } from '../../queued-message-edit-command'
import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand
} from './structured-agent-session-composer'

describe('dispatchStructuredAgentSessionComposerCommand', () => {
  const controller = {
    agent: 'codex' as const,
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true
  }
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

  it('hands /compact its text only where the host takes instructions, and never /clear', async () => {
    const runConversationCommand = vi.fn(async () => ({ accepted: true, error: null }))
    const taking = {
      ...controller,
      conversationCommands: ['clear', 'compact'] as const,
      compactInstructions: true,
      runConversationCommand
    }
    expect(
      await dispatchStructuredAgentSessionComposerCommand(
        '/compact keep the decisions\nand the plan\n',
        taking
      )
    ).toMatchObject({ handled: true, accepted: true })
    expect(runConversationCommand).toHaveBeenCalledWith(
      'compact',
      'keep the decisions\nand the plan'
    )
    runConversationCommand.mockClear()
    for (const text of ['/clear keep this', '/clear keep this\nand that']) {
      expect(await dispatchStructuredAgentSessionComposerCommand(text, taking)).toMatchObject({
        handled: true,
        accepted: false,
        errorCode: 'commandTakesNoArguments'
      })
    }
    expect(runConversationCommand).not.toHaveBeenCalled()
  })

  it.each(['\n', '\r', '\u2028', '\u2029'])(
    'leaves a message with line break %j after another command to the agent',
    async (lineBreak) => {
      const setOption = vi.fn(async () => true)
      expect(
        await dispatchStructuredAgentSessionComposerCommand(
          `/model picker looks wrong${lineBreak}see the log`,
          { ...controller, setOption }
        )
      ).toMatchObject({ handled: false })
      expect(setOption).not.toHaveBeenCalled()
    }
  )
})

describe('agent-implemented commands pass through to the agent', () => {
  const controller = {
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true
  }
  const PASSED_THROUGH = { handled: false, accepted: false, error: null }

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
