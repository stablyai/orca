import { describe, expect, it } from 'vitest'
import { paneShowsWslHostStoppedCard } from './wsl-host-stopped-status'

const STOPPED_HERE = {
  wslHostUnavailable: false,
  stoppedWslDistro: 'Ubuntu',
  ownerEnvironmentId: 'wsl:ubuntu'
}

describe('paneShowsWslHostStoppedCard', () => {
  it("shows the card on the stopped host's panes, including one whose create failed", () => {
    expect(paneShowsWslHostStoppedCard({ ...STOPPED_HERE, paneEnvironmentId: 'wsl:ubuntu' })).toBe(
      true
    )
    expect(paneShowsWslHostStoppedCard({ ...STOPPED_HERE, paneEnvironmentId: null })).toBe(true)
  })

  it('leaves a pane on another server its own error', () => {
    expect(paneShowsWslHostStoppedCard({ ...STOPPED_HERE, paneEnvironmentId: 'ssh:desk' })).toBe(
      false
    )
  })

  it('leaves a host that cannot run to its own notice, and a running host alone', () => {
    expect(
      paneShowsWslHostStoppedCard({
        ...STOPPED_HERE,
        wslHostUnavailable: true,
        paneEnvironmentId: 'wsl:ubuntu'
      })
    ).toBe(false)
    expect(
      paneShowsWslHostStoppedCard({
        ...STOPPED_HERE,
        stoppedWslDistro: null,
        paneEnvironmentId: 'wsl:ubuntu'
      })
    ).toBe(false)
  })
})
