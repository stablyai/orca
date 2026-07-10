import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { supportsTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { getTerminalQuickCommandAgentOptions } from './terminal-quick-command-agent-options'

describe('terminal quick command agent options', () => {
  it('does not inherit OpenClaude as the second quick-command agent option', () => {
    const ids = getTerminalQuickCommandAgentOptions().map((entry) => entry.id)

    expect(ids.slice(0, 3)).toEqual(['claude', 'codex', 'gemini'])
    expect(ids.indexOf('openclaude')).toBeGreaterThan(ids.indexOf('command-code'))
  })

  it('keeps unsupported prompt-command agents below supported agents', () => {
    const ids = getTerminalQuickCommandAgentOptions().map((entry) => entry.id)
    const firstUnsupportedIndex = ids.findIndex((id) => !supportsTerminalAgentQuickCommand(id))
    const lastSupportedIndex = ids.reduce(
      (lastIndex, id, index) => (supportsTerminalAgentQuickCommand(id) ? index : lastIndex),
      -1
    )

    expect(firstUnsupportedIndex).toBeGreaterThan(-1)
    expect(lastSupportedIndex).toBeLessThan(firstUnsupportedIndex)
  })

  it('keeps the same agent set as the global catalog', () => {
    expect(new Set(getTerminalQuickCommandAgentOptions().map((entry) => entry.id))).toEqual(
      new Set(AGENT_CATALOG.map((entry) => entry.id))
    )
  })
})
