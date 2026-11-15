import { toAgentLaunchPreferences } from '../choices/agent-launch-preferences'
import { resolveAgentSessionOptionLaunch } from '../../agent-session/options/launch/agent-session-option-launch'
import { expect, it } from 'vitest'

it('never emits a chat-only effort into terminal argv or legacy host preferences', () => {
  const values = { model: 'opus', effort: 'ultracode' }
  const launch = resolveAgentSessionOptionLaunch('claude', values)
  expect(launch.args).not.toContain('ultracode')
  expect(launch.appliedValues).not.toHaveProperty('effort')
  expect(toAgentLaunchPreferences(values, 'claude')).toEqual({ model: 'opus' })
})
