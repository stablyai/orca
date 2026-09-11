import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
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

  // The composer menu and the dispatcher read the same policy. When they disagreed,
  // a Claude session was offered Codex-only tokens that missed the command guard
  // and reached the model as literal prompt text instead of erroring. A row is
  // honored either way now: the host answers it, or it passes through to the agent.
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

  // Codex reports no catalog of its own, so this fallback is its whole `/` menu —
  // without the row, a command that now works is impossible to discover.
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
    // Picking it must reach the model, not the host's refusal.
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

describe('isStructuredAgentSessionComposerCommand', () => {
  // The menu hides TUI-only commands, but the guard must still claim a typed one
  // so it is answered here instead of sent to the model as prose.
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

describe('isStructuredAgentSessionComposerCommand with a session report', () => {
  const reported = [
    { name: 'opsx:apply', kind: 'command' as const },
    { name: 'to-spec', kind: 'skill' as const }
  ]

  it('claims reported commands and skills the curated catalogs never knew', () => {
    expect(isStructuredAgentSessionComposerCommand('/opsx:apply', 'claude', reported)).toBe(true)
    expect(
      isStructuredAgentSessionComposerCommand('/to-spec write the spec', 'claude', reported)
    ).toBe(true)
  })

  it('stays false for a name the session never reported', () => {
    expect(isStructuredAgentSessionComposerCommand('/my-skill', 'claude', [])).toBe(false)
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

  // Claude's harness runs a slash command it finds in the message text, so
  // claiming these answered "not available" for commands that do work.
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

  // Codex's app-server has no slash parser, but the model owns goal tools and
  // creates a real goal from `/goal <objective>` arriving as prose.
  it('passes /goal through on Codex, arguments and all', async () => {
    expect(isStructuredAgentSessionComposerCommand('/goal', 'codex')).toBe(false)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/goal ship the fix', {
        ...controller,
        agent: 'codex'
      })
    ).toEqual(PASSED_THROUGH)
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
