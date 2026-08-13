import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { getRoomTabIds } from './use-room-tabs'

describe('room tab cleanup', () => {
  it('selects every tab for the deleted room across worktrees', () => {
    const tab = (id: string, entityId: string, contentType: Tab['contentType'] = 'room') =>
      ({ id, entityId, contentType }) as Tab

    expect(
      getRoomTabIds(
        {
          first: [tab('first-room', 'room-1'), tab('other-room', 'room-2')],
          second: [tab('second-room', 'room-1'), tab('terminal', 'room-1', 'terminal')]
        },
        'room-1'
      )
    ).toEqual(['first-room', 'second-room'])
  })
})
