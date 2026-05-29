import { describe, expect, it } from 'vitest'
import { getUpdateStatusSegmentModel } from './UpdateStatusSegment'

describe('getUpdateStatusSegmentModel', () => {
  it('labels idle-install waiting as queued instead of ready', () => {
    expect(
      getUpdateStatusSegmentModel({
        state: 'downloaded',
        version: '1.4.36',
        idleInstall: { phase: 'waiting-for-idle', activeAgentCount: 2 }
      })
    ).toMatchObject({
      icon: 'spinner',
      label: 'Update queued',
      tooltip: '2 agents still working; Orca v1.4.36 will update when idle'
    })
  })

  it('labels ordinary downloaded updates as ready', () => {
    expect(
      getUpdateStatusSegmentModel({
        state: 'downloaded',
        version: '1.4.36'
      })
    ).toMatchObject({
      icon: 'check',
      label: 'Update ready'
    })
  })
})
