import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

describe('unattended agent startup updates', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)(
    'keeps Aider suppression after configured switches and before positional files in %s',
    (shell) => {
      const input = {
        agent: 'aider' as const,
        prompt: 'Review the files',
        cmdOverrides: {},
        platform: 'win32' as const,
        shell,
        agentArgs: '--check-update --show-release-notes -- notes.md'
      }
      const ordinary = buildAgentStartupPlan(input)
      const unattended = buildAgentStartupPlan({ ...input, suppressStartupUpdatePrompt: true })
      const parsed = tokenizeStartupCommand(unattended?.launchCommand ?? '', shell)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      expect(parsed.tokens).toEqual([
        'aider',
        '--check-update',
        '--show-release-notes',
        '--no-check-update',
        '--no-show-release-notes',
        '--',
        'notes.md'
      ])
      expect(unattended?.launchConfig).toEqual(ordinary?.launchConfig)
    }
  )
})
