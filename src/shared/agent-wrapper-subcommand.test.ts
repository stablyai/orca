import { describe, expect, it } from 'vitest'
import { getWrapperSubcommand, lacksWrapperSubcommand } from './agent-wrapper-subcommand'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

describe('agent wrapper subcommands', () => {
  it('derives exactly the wrapper binaries from the launch config', () => {
    // Why: pinning the full set catches an agent whose launch line accidentally reads as a
    // wrapper (space-separated flags with a mismatched expectedProcess) and would then never
    // be recognized from its bare command line.
    const wrappers = Object.fromEntries(
      (Object.keys(TUI_AGENT_CONFIG) as TuiAgent[])
        .map((agent) => [agent, getWrapperSubcommand(agent)] as const)
        .filter(([, subcommand]) => subcommand !== null)
    )
    expect(wrappers).toEqual({ 'claude-agent-teams': 'claude-teams', openzoo: 'claude' })
  })

  it('only rejects a wrapper whose subcommand is not the hosted agent', () => {
    expect(lacksWrapperSubcommand('openzoo', 'claude')).toBe(false)
    expect(lacksWrapperSubcommand('openzoo', 'CLAUDE')).toBe(false)
    expect(lacksWrapperSubcommand('openzoo', 'proxy')).toBe(true)
    expect(lacksWrapperSubcommand('openzoo', undefined)).toBe(true)
    expect(lacksWrapperSubcommand('claude-agent-teams', 'status')).toBe(true)
    expect(lacksWrapperSubcommand('kiro', 'status')).toBe(false)
    expect(lacksWrapperSubcommand('claude', undefined)).toBe(false)
    expect(lacksWrapperSubcommand(undefined, 'claude')).toBe(false)
  })
})
