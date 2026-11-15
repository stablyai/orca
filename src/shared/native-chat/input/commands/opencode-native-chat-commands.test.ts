import { describe, expect, it } from 'vitest'
import { getAgentSlashCommands } from './native-chat-slash-commands'
import { getTextDrivenNativeChatCommands } from '../../native-chat-agent-profiles'
import {
  structuredSlashCommands,
  structuredSessionSlashCommands
} from '../../../agent-session/view/structured-agent-session-composer'

describe('OpenCode slash command integration in native chat', () => {
  it('exposes curated slash commands for opencode and opencode2', () => {
    const opencodeCommands = getAgentSlashCommands('opencode')
    const opencode2Commands = getAgentSlashCommands('opencode2')

    expect(opencodeCommands).toEqual(opencode2Commands)
    expect(opencode2Commands.map((command) => command.name)).toContain('session')
    expect(opencode2Commands.map((command) => command.name)).toContain('sessions')
    expect(opencode2Commands.map((command) => command.name)).toContain('clear')
    expect(opencode2Commands.map((command) => command.name)).toContain('compact')
  })

  it('exposes text-driven commands when the agent expands slash commands from text', () => {
    const commands = getTextDrivenNativeChatCommands('opencode2')
    const sessionCommand = commands.find((command) => command.name === 'session')

    expect(sessionCommand).toBeDefined()
    expect(sessionCommand?.description).toBe('Show session information and controls')
  })

  it('includes /session in structured session slash commands when reported catalog is empty', () => {
    const commands = structuredSessionSlashCommands('opencode2', [], [])
    const names = commands.map((command) => command.name)

    expect(names).toContain('model')
    expect(names).toContain('effort')
    expect(names).toContain('session')
  })

  it('includes /session in fallback structured slash commands', () => {
    const commands = structuredSlashCommands([], 'opencode2')
    const names = commands.map((command) => command.name)

    expect(names).toContain('session')
  })
})
