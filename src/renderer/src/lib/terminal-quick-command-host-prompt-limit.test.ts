import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH } from '../../../shared/terminal-quick-command-prompt-limit'
import { TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY } from '../../../shared/terminal-quick-command-capabilities'
import { getTerminalQuickCommandHostPromptMaxLength } from './terminal-quick-command-host-prompt-limit'

function stateWithHostCapabilities(
  capabilities: string[] | null
): Pick<AppState, 'runtimeStatusByEnvironmentId'> {
  const entries: [string, { status: { capabilities: string[] } }][] = capabilities
    ? [['env-1', { status: { capabilities } }]]
    : []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cap reads only the verified status capabilities of this one entry.
  return { runtimeStatusByEnvironmentId: new Map(entries) } as unknown as Pick<
    AppState,
    'runtimeStatusByEnvironmentId'
  >
}

describe('the desktop editor’s agent-prompt cap for a host', () => {
  it('holds an older paired host to the cap it enforces itself', () => {
    expect(
      getTerminalQuickCommandHostPromptMaxLength(
        stateWithHostCapabilities(['terminal.quick-commands.v1']),
        'runtime:env-1'
      )
    ).toBe(LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH)
  })

  it('gives a current paired host, this computer, and an unverified host no character cap', () => {
    expect(
      getTerminalQuickCommandHostPromptMaxLength(
        stateWithHostCapabilities([TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY]),
        'runtime:env-1'
      )
    ).toBeNull()
    expect(
      getTerminalQuickCommandHostPromptMaxLength(stateWithHostCapabilities(null), 'local')
    ).toBeNull()
    // An older host refuses visibly itself, so an unknown one must not block a save.
    expect(
      getTerminalQuickCommandHostPromptMaxLength(stateWithHostCapabilities(null), 'runtime:env-1')
    ).toBeNull()
  })
})
