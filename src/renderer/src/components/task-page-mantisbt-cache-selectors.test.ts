import { describe, expect, it } from 'vitest'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'
import { findTaskPageMantisBTIssue } from './task-page-mantisbt-cache-selectors'

function mantisBTSourceContext(environmentId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'mantisBT',
    projectId: 'logical-project',
    hostId: `runtime:${environmentId}`,
    providerIdentity: {
      provider: 'mantisBT',
      siteId: 'site-1'
    }
  }
}

function mantisBTIssue(id: string, summary: string, siteId = 'site-1'): MantisBTIssue {
  return {
    id,
    summary,
    url: `https://example.com/view.php?id=${id}`,
    siteId,
    siteName: 'Example MantisBT',
    project: { id: '1', siteId, name: 'Alpha', subProjects: [] },
    status: { id: '10', name: 'new', label: 'new' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('findTaskPageMantisBTIssue', () => {
  it('keeps same-id MantisBT issues separated by source context', () => {
    const localSource = mantisBTSourceContext('local-runtime')
    const remoteSource = mantisBTSourceContext('remote-runtime')
    const localScope = getTaskSourceCacheScope(localSource)
    const remoteScope = getTaskSourceCacheScope(remoteSource)

    const found = findTaskPageMantisBTIssue(
      {
        [`${localScope}::site-1::123`]: {
          data: mantisBTIssue('123', 'Local issue'),
          fetchedAt: Date.now()
        }
      },
      {
        [`${remoteScope}::site-1::list::assigned::30`]: {
          data: [mantisBTIssue('123', 'Remote issue')],
          fetchedAt: Date.now()
        }
      },
      '123',
      {
        sourceContext: remoteSource,
        siteId: 'site-1'
      }
    )

    expect(found?.summary).toBe('Remote issue')
  })

  it('filters same-id MantisBT issues by site id', () => {
    const source = mantisBTSourceContext('remote-runtime')
    const scope = getTaskSourceCacheScope(source)

    const found = findTaskPageMantisBTIssue(
      {},
      {
        [`${scope}::site-1::list::assigned::30`]: {
          data: [mantisBTIssue('123', 'Site one issue', 'site-1')],
          fetchedAt: Date.now()
        },
        [`${scope}::site-2::list::assigned::30`]: {
          data: [mantisBTIssue('123', 'Site two issue', 'site-2')],
          fetchedAt: Date.now()
        }
      },
      '123',
      {
        sourceContext: source,
        siteId: 'site-2'
      }
    )

    expect(found?.summary).toBe('Site two issue')
  })
})
