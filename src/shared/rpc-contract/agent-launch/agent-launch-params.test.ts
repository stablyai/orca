// Unknown telemetry labels from newer clients must not block launches on older hosts.

import { describe, expect, it } from 'vitest'
import { AgentLaunch } from './agent-launch-params'

const BASE = { agent: 'claude', target: { kind: 'existing', worktree: 'wt-1' } }

describe('agent.launch params', () => {
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
