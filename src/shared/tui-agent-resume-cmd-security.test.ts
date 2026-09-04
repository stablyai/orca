import { describe, expect, it } from 'vitest'

import { buildAgentResumeStartupPlan } from './tui-agent-startup'

describe('cmd agent resume security', () => {
  it('accepts ordinary values and rejects bytes that can change cmd parsing', () => {
    expect(
      buildAgentResumeStartupPlan({
        agent: 'grok',
        providerSession: { key: 'session_id', id: 'session with spaces' },
        cmdOverrides: {},
        platform: 'win32',
        shell: 'cmd'
      })?.launchCommand
    ).toBe('grok "--resume" "session with spaces"')

    for (const id of [
      'session & whoami',
      'session ^ caret',
      'session" --help "tail',
      'session%PATH%',
      'session!value!',
      'session\\'
    ]) {
      expect(
        buildAgentResumeStartupPlan({
          agent: 'grok',
          providerSession: { key: 'session_id', id },
          cmdOverrides: {},
          platform: 'win32',
          shell: 'cmd'
        })
      ).toBeNull()
    }
  })
})
