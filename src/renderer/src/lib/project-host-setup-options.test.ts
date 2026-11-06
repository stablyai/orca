import { describe, expect, it } from 'vitest'
import { getComposerActionableHostIds } from './project-host-setup-options'

describe('getComposerActionableHostIds', () => {
  it('leaves per-workspace VM hosts out, so a VM repo without a visible checkout cannot become the target', () => {
    const hostIds = getComposerActionableHostIds([
      { id: 'local', kind: 'local', label: 'Local Mac', detail: 'This computer', health: 'local' },
      {
        id: 'runtime:vm-1',
        kind: 'runtime',
        label: 'app VM',
        detail: 'Orca server',
        health: 'available',
        source: 'ephemeral-vm'
      },
      {
        id: 'runtime:build-box',
        kind: 'runtime',
        label: 'Build box',
        detail: 'Orca server',
        health: 'available',
        source: 'manual'
      }
    ])

    expect([...hostIds]).toEqual(['local', 'runtime:build-box'])
  })
})
