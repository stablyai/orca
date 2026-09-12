import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDefaultEnv,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'

describe('Grok launch privacy defaults', () => {
  it('opts Orca-launched Grok out of trace upload by default', () => {
    expect(getTuiAgentDefaultEnv('grok')).toEqual({
      GROK_TELEMETRY_TRACE_UPLOAD: '0'
    })
    expect(resolveTuiAgentLaunchEnv('grok', undefined)).toEqual({
      GROK_TELEMETRY_TRACE_UPLOAD: '0'
    })
    // Other agents' configured env does not block Grok defaults.
    expect(resolveTuiAgentLaunchEnv('grok', { goose: { GOOSE_MODE: 'auto' } })).toEqual({
      GROK_TELEMETRY_TRACE_UPLOAD: '0'
    })
  })

  it('honors an explicit empty or custom Grok agentDefaultEnv override', () => {
    expect(resolveTuiAgentLaunchEnv('grok', { grok: {} })).toEqual({})
    expect(
      resolveTuiAgentLaunchEnv('grok', {
        grok: { GROK_TELEMETRY_TRACE_UPLOAD: '1', GROK_HOME: '/tmp/g' }
      })
    ).toEqual({ GROK_TELEMETRY_TRACE_UPLOAD: '1', GROK_HOME: '/tmp/g' })
  })
})
