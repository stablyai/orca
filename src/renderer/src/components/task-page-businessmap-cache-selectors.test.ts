import { describe, expect, it } from 'vitest'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { BusinessmapCard } from '../../../shared/businessmap-types'
import { findTaskPageBusinessmapCard } from './task-page-businessmap-cache-selectors'

function businessmapSourceContext(environmentId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'businessmap',
    projectId: 'logical-project',
    hostId: `runtime:${environmentId}`,
    providerIdentity: {
      provider: 'businessmap',
      subdomain: 'acme'
    }
  }
}

function businessmapCard(id: number, title: string): BusinessmapCard {
  return {
    id,
    boardId: 7,
    title,
    url: `https://acme.businessmap.io/cards/${id}`,
    column: { id: 3, name: 'To Do' },
    workflowId: 1,
    labels: [],
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('findTaskPageBusinessmapCard', () => {
  it('keeps same-id cards separated by source context', () => {
    const localSource = businessmapSourceContext('local-runtime')
    const remoteSource = businessmapSourceContext('remote-runtime')
    const localScope = getTaskSourceCacheScope(localSource)
    const remoteScope = getTaskSourceCacheScope(remoteSource)

    const found = findTaskPageBusinessmapCard(
      {
        [`${localScope}::42`]: {
          data: businessmapCard(42, 'Local card'),
          fetchedAt: Date.now()
        }
      },
      {
        [`${remoteScope}::list::assigned::30`]: {
          data: [businessmapCard(42, 'Remote card')],
          fetchedAt: Date.now()
        }
      },
      42,
      { sourceContext: remoteSource }
    )

    expect(found?.title).toBe('Remote card')
  })

  it('returns null for an unknown card id', () => {
    const found = findTaskPageBusinessmapCard({}, {}, 99, {
      sourceContext: businessmapSourceContext('local-runtime')
    })

    expect(found).toBeNull()
  })
})
