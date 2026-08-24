import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { getTuiAgentUsageSupport, TUI_AGENT_USAGE_SUPPORT } from './tui-agent-usage-support'

describe('TuiAgent usage support catalog', () => {
  it('covers every Orca launchable agent without PATH detection', () => {
    expect(Object.keys(TUI_AGENT_USAGE_SUPPORT).sort()).toEqual(
      Object.keys(TUI_AGENT_CONFIG).sort()
    )
  })

  it('maps only adapters with a matching usage provider', () => {
    expect(getTuiAgentUsageSupport('claude')).toEqual({
      usageProvider: 'claude',
      usageAuth: 'oauth-or-cli',
      planLabelSource: 'provider-account'
    })
    expect(getTuiAgentUsageSupport('claude-agent-teams')).toEqual({
      usageProvider: 'claude',
      usageAuth: 'oauth-or-cli',
      planLabelSource: 'provider-account'
    })
    expect(getTuiAgentUsageSupport('codex')).toEqual({
      usageProvider: 'codex',
      usageAuth: 'oauth',
      planLabelSource: 'provider-account'
    })
    expect(getTuiAgentUsageSupport('grok')).toEqual({
      usageProvider: 'grok',
      usageAuth: 'oauth',
      planLabelSource: 'provider-account'
    })
    expect(getTuiAgentUsageSupport('opencode')).toEqual({
      usageProvider: null,
      usageAuth: 'none',
      planLabelSource: 'not-exposed'
    })
  })
})
