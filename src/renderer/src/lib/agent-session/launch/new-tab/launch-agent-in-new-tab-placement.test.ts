import { describe, expect, it } from 'vitest'
import { mockCreateTab } from './launch-agent-in-new-tab-test-fixture'

describe('launchAgentInNewTab terminal tab activation', () => {
  it('keeps a pinned panel launch in that panel', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-pinned',
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'left',
      requestedSurface: 'terminal',
      placementFixed: true
    })

    expect(mockCreateTab.mock.calls[0]?.[1]).toBe('left')
    expect(mockCreateTab.mock.calls[0]?.[3]).toMatchObject({ placementFixed: true })
  })
})
