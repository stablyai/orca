import { describe, expect, it } from 'vitest'
import {
  isStructuredAgentSessionComposerCommand,
  structuredSlashCommands
} from './structured-agent-session-composer'

describe('structuredSlashCommands', () => {
  // The composer menu and the dispatcher read this one list. When they disagreed,
  // a Claude session was offered Codex-only tokens that missed the command guard
  // and reached the model as literal prompt text instead of erroring.
  it.each(['codex', 'claude'] as const)('offers %s only commands it also accepts', (agent) => {
    const offered = structuredSlashCommands(agent)
    expect(offered.length).toBeGreaterThan(0)
    for (const command of offered) {
      expect(isStructuredAgentSessionComposerCommand(`/${command.name}`, agent)).toBe(true)
    }
  })

  it('offers each agent its own catalog', () => {
    const claude = structuredSlashCommands('claude').map((command) => command.name)
    expect(claude).toContain('compact')
    expect(claude).not.toContain('vim')
    expect(structuredSlashCommands('codex').map((command) => command.name)).toContain('vim')
  })

  it('offers effort to every structured agent', () => {
    for (const agent of ['codex', 'claude'] as const) {
      expect(structuredSlashCommands(agent).map((command) => command.name)).toContain('effort')
    }
  })
})
