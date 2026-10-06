import { describe, expect, it } from 'vitest'
import { planLaunchForTest } from './launch-prompt-plan.test-fixture'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

describe('Qoder China launch recipe identity', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'preserves the official China executable on %s',
    (platform) => {
      const plan = planLaunchForTest({
        agent: 'qoder-cn',
        prompt: 'fixture',
        cmdOverrides: {},
        platform
      })
      expect(plan?.agent).toBe('qoder-cn')
      expect(plan?.launchCommand).toBe("qoderclicn --prompt-interactive 'fixture'")
      expect(
        buildAgentResumeStartupPlan({
          agent: 'qoder-cn',
          providerSession: { key: 'session_id', id: 'fixture-session' },
          cmdOverrides: {},
          platform
        })?.launchCommand
      ).toBe("qoderclicn '--resume' 'fixture-session'")
    }
  )

  it.each(['darwin', 'linux', 'win32'] as const)(
    'preserves an explicitly configured shared-binary --cn recipe on %s',
    (platform) => {
      const cmdOverrides = { 'qoder-cn': 'qodercli --cn' }
      const plan = planLaunchForTest({
        agent: 'qoder-cn',
        prompt: 'fixture',
        cmdOverrides,
        platform
      })
      expect(plan?.agent).toBe('qoder-cn')
      expect(plan?.launchCommand).toBe("qodercli --cn --prompt-interactive 'fixture'")
      expect(
        buildAgentResumeStartupPlan({
          agent: 'qoder-cn',
          providerSession: { key: 'session_id', id: 'fixture-session' },
          cmdOverrides,
          platform
        })?.launchCommand
      ).toBe("qodercli --cn '--resume' 'fixture-session'")
    }
  )
})
