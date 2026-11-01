import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

describe('DSH first launch', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'plans the current workspace with task input deferred on %s',
    (platform) => {
      const plan = buildAgentStartupPlan({
        agent: 'dsh',
        prompt: 'Review this folder',
        cmdOverrides: {},
        platform
      })
      expect(plan?.launchCommand).toContain('dsh-tui .')
      expect(plan?.launchCommand).not.toContain('Review this folder')
      expect(TUI_AGENT_CONFIG.dsh.promptInjectionMode).toBe('stdin-after-start')
      expect(TUI_AGENT_CONFIG.dsh.draftPasteReadySignal).toBe('dsh-composer-prompt')
    }
  )
})
