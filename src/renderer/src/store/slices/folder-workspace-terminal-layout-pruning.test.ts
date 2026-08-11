import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../runtime/runtime-terminal-stream'
import { pruneOwnedTerminalLayout } from './folder-workspace-terminal-layout-pruning'

describe('folder workspace terminal layout pruning', () => {
  it('clears expansion when pruning collapses the root to one leaf', () => {
    const ownerLeafId = 'owner-leaf'
    const survivorLeafId = 'survivor-leaf'
    const result = pruneOwnedTerminalLayout(
      {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: ownerLeafId },
          second: { type: 'leaf', leafId: survivorLeafId }
        },
        activeLeafId: survivorLeafId,
        expandedLeafId: survivorLeafId,
        ptyIdsByLeafId: {
          [ownerLeafId]: toRemoteRuntimePtyId('owner-pty', 'owner-runtime'),
          [survivorLeafId]: toRemoteRuntimePtyId('survivor-pty', 'survivor-runtime')
        }
      },
      { kind: 'runtime', environmentId: 'owner-runtime' }
    )

    expect(result.layout).toMatchObject({
      root: { type: 'leaf', leafId: survivorLeafId },
      activeLeafId: survivorLeafId,
      expandedLeafId: null
    })
  })
})
