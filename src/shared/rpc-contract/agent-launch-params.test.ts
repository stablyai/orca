/**
 * The wire shape of the launch inputs a host cannot derive.
 *
 * Params are validated by the HOST, which makes every closed arm set here a refusal a future client
 * walks into. `launchSource` is the case that matters: it is a telemetry label, and a host that
 * rejected an unfamiliar one would fail the user's launch over bookkeeping.
 */

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
})
