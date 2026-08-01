import { describe, expect, it } from 'vitest'

import { planLaunchAgentStartupPrompt } from './launch-agent-startup-prompt-plan'

const base = {
  agent: 'opencode' as const,
  cmdOverrides: {},
  platform: 'linux' as const
}

describe('planLaunchAgentStartupPrompt', () => {
  it('uses OpenCode prompt submission for a fitting continuation prompt', () => {
    const result = planLaunchAgentStartupPrompt({
      base,
      prompt: 'Continue the previous task from the saved context.',
      promptDelivery: 'submit-after-ready',
      isFollowupPath: false
    })

    expect(result.pasteDraftAfterLaunch).toBeNull()
    expect(result.submitPastedPrompt).toBe(false)
    expect(result.startupPlan?.launchCommand).toContain(
      "opencode --prompt 'Continue the previous task from the saved context.'"
    )
  })

  it('keeps post-ready paste for an oversized Windows continuation prompt', () => {
    const prompt = 'x'.repeat(25_000)
    const result = planLaunchAgentStartupPrompt({
      base: { ...base, platform: 'win32' },
      prompt,
      promptDelivery: 'submit-after-ready',
      isFollowupPath: false
    })

    expect(result.startupPlan?.launchCommand).toBe('opencode')
    expect(result.pasteDraftAfterLaunch).toBe(prompt)
    expect(result.submitPastedPrompt).toBe(true)
  })
})
