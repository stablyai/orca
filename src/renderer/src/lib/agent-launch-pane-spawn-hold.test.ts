import { describe, expect, it } from 'vitest'
import {
  agentLaunchPaneSpawnHold,
  holdAgentLaunchPaneSpawn,
  isAgentLaunchPaneSpawnHeld,
  releaseAgentLaunchPaneSpawn
} from './agent-launch-pane-spawn-hold'

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe('a launch pane this window made', () => {
  it('holds its spawn until the host takes the pane', async () => {
    holdAgentLaunchPaneSpawn(TAB, LEAF)
    const held = agentLaunchPaneSpawnHold(TAB, LEAF)
    let spawned = false
    void held?.then(() => {
      spawned = true
    })
    await Promise.resolve()
    expect(spawned).toBe(false)
    expect(isAgentLaunchPaneSpawnHeld(TAB, LEAF)).toBe(true)

    expect(releaseAgentLaunchPaneSpawn(TAB, LEAF)).toBe(true)
    await held
    expect(spawned).toBe(true)
    expect(isAgentLaunchPaneSpawnHeld(TAB, LEAF)).toBe(false)
    expect(releaseAgentLaunchPaneSpawn(TAB, LEAF)).toBe(false)
  })

  it('ends the hold when the launch is over, and a second end is harmless', async () => {
    const release = holdAgentLaunchPaneSpawn(TAB, LEAF)
    const held = agentLaunchPaneSpawnHold(TAB, LEAF)
    release()
    release()
    await expect(held).resolves.toBeUndefined()
    expect(agentLaunchPaneSpawnHold(TAB, LEAF)).toBeNull()
  })

  it('holds nothing for any other pane', () => {
    const release = holdAgentLaunchPaneSpawn(TAB, LEAF)
    expect(agentLaunchPaneSpawnHold(TAB, 'another-leaf')).toBeNull()
    expect(agentLaunchPaneSpawnHold(undefined, LEAF)).toBeNull()
    release()
  })
})
