/**
 * The wire shape of the launch inputs a host cannot derive.
 *
 * Params are validated by the HOST, which makes every closed arm set here a refusal a future client
 * walks into. `launchSource` is the case that matters: it is a telemetry label, and a host that
 * rejected an unfamiliar one would fail the user's launch over bookkeeping.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentLaunch, AgentLaunchFields } from './agent-launch-params'

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
    // The arm set is open ON PURPOSE. A newer client naming a surface this host predates must still
    // get its agent started; the label is re-checked where it is used and dropped if unknown.
    const parsed = AgentLaunch.safeParse({ ...BASE, launchSource: 'a_surface_added_later' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.launchSource).toBe('a_surface_added_later')
  })

  it('still parses a payload from a client that sends none of these fields', () => {
    // Rule 1: the fields are optional, so a shipped client that predates them is unaffected.
    const parsed = AgentLaunch.parse(BASE)
    expect(parsed).not.toHaveProperty('cwd')
    expect(parsed).not.toHaveProperty('launchSource')
  })

  it('lets a host from before the reservation drop it rather than refuse the launch', () => {
    // Rule 1 from the other side: a newer phone reserves its pane and chat on every launch.
    const olderHost = AgentLaunchFields.omit({ paneKey: true, sessionId: true })
    const parsed = olderHost.safeParse({
      ...BASE,
      paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
      sessionId: 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty('paneKey')
    expect(parsed.data).not.toHaveProperty('sessionId')
  })

  it('reads placement and presentation, and never refuses a launch over either', () => {
    const parsed = AgentLaunch.parse({
      ...BASE,
      placement: { groupId: 'group-1', afterTabId: 'tab-1', splitDirection: 'right' },
      presentation: 'background'
    })
    expect(parsed.placement).toEqual({ groupId: 'group-1', afterTabId: 'tab-1' })
    expect(parsed.presentation).toBe('background')
    // A word added later reads as absent: it is about the view, not whether the agent runs.
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

  it('has a host from before folder creates refuse that target rather than misread it', () => {
    const [existing, createWorktree] = AgentLaunchFields.shape.target.options
    const olderHost = AgentLaunchFields.extend({
      target: z.discriminatedUnion('kind', [existing, createWorktree])
    })
    expect(
      olderHost.safeParse({
        ...BASE,
        target: { kind: 'create-folder-workspace', create: { projectGroupId: 'group-1' } }
      }).success
    ).toBe(false)
  })

  it('lets a host from before placement drop it rather than refuse the launch', () => {
    const olderHost = AgentLaunchFields.omit({ placement: true, presentation: true })
    const parsed = olderHost.safeParse({
      ...BASE,
      placement: { groupId: 'group-1' },
      presentation: 'focused'
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty('placement')
    expect(parsed.data).not.toHaveProperty('presentation')
  })
})
