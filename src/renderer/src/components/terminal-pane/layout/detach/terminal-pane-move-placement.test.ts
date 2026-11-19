import { describe, expect, it } from 'vitest'
import { newTabTargetBesideSource } from './terminal-pane-move-placement'

const WT = 'repo::/wt'

function state(tabOrder: string[]) {
  return {
    groupsByWorktree: { [WT]: [{ id: 'group-1', tabOrder }] },
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: 'unified-source',
          entityId: 'terminal-source',
          contentType: 'terminal',
          groupId: 'group-1'
        }
      ]
    }
  }
}

describe('where a pane moved without a drop goes', () => {
  it('opens its tab right after the source tab', () => {
    expect(
      newTabTargetBesideSource(state(['a', 'unified-source', 'b']), WT, 'terminal-source')
    ).toEqual({ groupId: 'group-1', index: 2 })
  })
})
