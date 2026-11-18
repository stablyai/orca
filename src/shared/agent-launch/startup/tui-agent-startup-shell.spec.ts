import { describe, expect, it } from 'vitest'
import { buildAgentDraftLaunchPlan } from './tui-agent-startup'

describe('one Unix startup dialect', () => {
  it('leaves a multi-line argv draft to the paste fallback in cmd.exe', () => {
    const draft = 'Linked Linear issue: ENG-1\nhttps://linear.app/acme/issue/ENG-1'
    const args = { agent: 'claude' as const, draft, cmdOverrides: {}, platform: 'win32' as const }

    expect(buildAgentDraftLaunchPlan({ ...args, shell: 'cmd' })).toBeNull()
    expect(buildAgentDraftLaunchPlan({ ...args, shell: 'powershell' })?.launchCommand).toContain(
      '`n'
    )
  })
})
