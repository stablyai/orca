import { describe, expect, it } from 'vitest'
import { mapRestoredPaneTitlesByPaneId } from './restored-pane-titles'

describe('mapRestoredPaneTitlesByPaneId', () => {
  it('restores persisted pane titles onto newly-created pane ids', () => {
    const restoredPaneByLeafId = new Map([
      ['11111111-1111-4111-8111-111111111111', 7],
      ['22222222-2222-4222-8222-222222222222', 3]
    ])

    expect(
      mapRestoredPaneTitlesByPaneId(
        {
          '11111111-1111-4111-8111-111111111111': 'build logs',
          '22222222-2222-4222-8222-222222222222': 'test runner'
        },
        restoredPaneByLeafId
      )
    ).toEqual({
      7: 'build logs',
      3: 'test runner'
    })
  })

  it('ignores stale leaf ids and empty persisted titles', () => {
    expect(
      mapRestoredPaneTitlesByPaneId(
        {
          '11111111-1111-4111-8111-111111111111': 'build logs',
          '22222222-2222-4222-8222-222222222222': '',
          '33333333-3333-4333-8333-333333333333': 'closed pane'
        },
        new Map([['11111111-1111-4111-8111-111111111111', 2]])
      )
    ).toEqual({ 2: 'build logs' })
  })
})
