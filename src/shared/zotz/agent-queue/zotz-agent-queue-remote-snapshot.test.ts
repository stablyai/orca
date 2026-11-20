import { describe, expect, it } from 'vitest'
import { normalizeRemoteZotzAgentQueueSnapshot } from './zotz-agent-queue-remote-snapshot'

describe('normalizeRemoteZotzAgentQueueSnapshot', () => {
  it('rejects anything that is not an object', () => {
    expect(normalizeRemoteZotzAgentQueueSnapshot(null)).toBeNull()
    expect(normalizeRemoteZotzAgentQueueSnapshot('queue')).toBeNull()
    expect(normalizeRemoteZotzAgentQueueSnapshot([])).toBeNull()
  })

  it('fills fields an older server omits and drops malformed entries instead of failing', () => {
    const snapshot = normalizeRemoteZotzAgentQueueSnapshot({
      memory: { totalBytes: 'a lot' },
      queued: [
        {
          id: 'pane-1',
          agent: 'claude',
          priority: 'manual',
          label: 'uni',
          estimatedBytes: 100,
          enqueuedAt: 5,
          position: 1,
          waitReason: 'pressure'
        },
        { id: 'broken', agent: 'claude' },
        null
      ]
    })
    expect(snapshot).toEqual({
      memory: null,
      running: [],
      done: [],
      queued: [
        {
          id: 'pane-1',
          agent: 'claude',
          priority: 'manual',
          label: 'uni',
          estimatedBytes: 100,
          enqueuedAt: 5,
          position: 1,
          waitReason: 'pressure'
        }
      ],
      canceled: []
    })
  })
})
