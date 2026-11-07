import { describe, expect, it } from 'vitest'
import { replayLayoutWithOneShotParkIntent } from './one-shot-park-replay'

describe('replayLayoutWithOneShotParkIntent', () => {
  it('exposes park intent to replayed panes and clears it before later splits', () => {
    const deps = { mountFollowsTerminalPark: true }
    const observedByReplayedPane: boolean[] = []

    const restored = replayLayoutWithOneShotParkIntent(deps, () => {
      observedByReplayedPane.push(deps.mountFollowsTerminalPark)
      return 'restored-panes'
    })

    expect(restored).toBe('restored-panes')
    expect(observedByReplayedPane).toEqual([true])
    // A split after replay reads the same deps object, so it must see ordinary reconnect semantics.
    expect(deps.mountFollowsTerminalPark).toBe(false)
  })

  it('clears park intent even when layout replay throws', () => {
    const deps = { mountFollowsTerminalPark: true }

    expect(() =>
      replayLayoutWithOneShotParkIntent(deps, () => {
        throw new Error('replay failed')
      })
    ).toThrow('replay failed')

    expect(deps.mountFollowsTerminalPark).toBe(false)
  })
})
