import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  structuredSessionSlashCommands
} from './structured-agent-session-composer'

describe('side chat commands', () => {
  it.each(['model', 'goal'])('preserves multiline /%s message passthrough', async (name) => {
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
  })

  it('keeps multiline compact instructions on the host command path with side chats enabled', async () => {
    const runConversationCommand = vi.fn(async () => ({ accepted: true, error: null }))
    const openSideChat = vi.fn(async () => true)
    const text = '/compact first line\nsecond line'
    expect(isStructuredAgentSessionComposerCommand(text, 'codex', undefined, true)).toBe(true)
    expect(
      await dispatchStructuredAgentSessionComposerCommand(text, {
        snapshot: [],
        invokeAction: async () => false,
        setOption: async () => false,
        conversationCommands: ['compact'],
        compactInstructions: true,
        runConversationCommand,
        openSideChat
      })
    ).toEqual({ handled: true, accepted: true, error: null })
    expect(runConversationCommand).toHaveBeenCalledExactlyOnceWith(
      'compact',
      'first line\nsecond line'
    )
    expect(openSideChat).not.toHaveBeenCalled()
  })

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

  it('uses declared support rather than agent names', async () => {
    const agent = 'claude' as const
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
      structuredSessionSlashCommands(agent, [], undefined, false, true).some(
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
  })
})
