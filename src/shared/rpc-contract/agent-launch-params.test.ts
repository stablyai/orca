// Unknown telemetry labels from newer clients must not block launches on older hosts.

import { describe, expect, it } from 'vitest'
import { AgentLaunch } from './agent-launch-params'

const BASE = { agent: 'claude', target: { kind: 'existing', worktree: 'wt-1' } }

describe('agent.launch params', () => {
  it('keeps agentArgs tri-state: a string, an explicit null, and absent are three answers', () => {
    expect(AgentLaunch.parse({ ...BASE, agentArgs: '--model opus' }).agentArgs).toBe('--model opus')
    expect(AgentLaunch.parse({ ...BASE, agentArgs: null }).agentArgs).toBeNull()
    expect(AgentLaunch.parse(BASE)).not.toHaveProperty('agentArgs')
  })

  it('accepts a cwd and rejects an empty one', () => {
    expect(AgentLaunch.parse({ ...BASE, cwd: '/repo/packages/api' }).cwd).toBe('/repo/packages/api')
    expect(AgentLaunch.safeParse({ ...BASE, cwd: '' }).success).toBe(false)
  })

  it('accepts a launchSource this build has never heard of', () => {
    const parsed = AgentLaunch.safeParse({ ...BASE, launchSource: 'a_surface_added_later' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.launchSource).toBe('a_surface_added_later')
  })

  it('still parses a payload from a client that sends none of these fields', () => {
    const parsed = AgentLaunch.parse(BASE)
    expect(parsed).not.toHaveProperty('cwd')
    expect(parsed).not.toHaveProperty('launchSource')
  })

  it('reads placement and presentation, and never refuses a launch over either', () => {
    const parsed = AgentLaunch.parse({
      ...BASE,
      placement: { groupId: 'group-1', afterTabId: 'tab-1', splitDirection: 'right' },
      presentation: 'background'
    })
    expect(parsed.placement).toEqual({ groupId: 'group-1', afterTabId: 'tab-1' })
    expect(parsed.presentation).toBe('background')
    expect(AgentLaunch.parse({ ...BASE, presentation: 'peek' }).presentation).toBeUndefined()
  })

  it('drops a placement id or a presentation that is not a string instead of refusing the launch', () => {
    expect(
      AgentLaunch.parse({ ...BASE, placement: { groupId: 7, afterTabId: 'tab-1' } }).placement
    ).toEqual({
      afterTabId: 'tab-1'
    })
    expect(AgentLaunch.parse({ ...BASE, placement: 'group-1' }).placement).toBeUndefined()
    expect(AgentLaunch.safeParse({ ...BASE, presentation: 5 })).toMatchObject({
      success: true,
      data: { presentation: undefined }
    })
  })
})
