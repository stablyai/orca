import { describe, expect, it } from 'vitest'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { parkedTerminalLeafDrivesTabTitle } from './terminal-parked-title-authority'

const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

describe('parked terminal title authority', () => {
  it('promotes the surviving watcher when the active split leaf exits', () => {
    const collapsed = detachTerminalLayoutLeaf(
      {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: FIRST_LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: FIRST_LEAF_ID,
        expandedLeafId: null
      },
      FIRST_LEAF_ID
    )
    if (!collapsed) {
      throw new Error('expected split collapse')
    }

    expect(
      parkedTerminalLeafDrivesTabTitle({
        activeLeafId: collapsed.sourceLayout.activeLeafId,
        leafId: SECOND_LEAF_ID,
        capturedAuthority: false
      })
    ).toBe(true)
  })

  it('lets current layout authority override stale captured authority', () => {
    expect(
      parkedTerminalLeafDrivesTabTitle({
        activeLeafId: SECOND_LEAF_ID,
        leafId: FIRST_LEAF_ID,
        capturedAuthority: true
      })
    ).toBe(false)
  })
})
