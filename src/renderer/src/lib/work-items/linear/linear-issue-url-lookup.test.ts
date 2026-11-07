import {
  linearIssueReadFixture,
  readLinearIssueForTest
} from '@/store/slices/linear/linear-slice-test-harness'
import { describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'

import { lookupLinearIssueUrl } from './linear-issue-url-lookup'

const intent = { identifier: 'STA-4084', organizationUrlKey: 'stably' }

function issue(organizationUrlKey = 'stably'): LinearIssue {
  return {
    id: `${organizationUrlKey}-issue`,
    workspaceId: `${organizationUrlKey}-workspace`,
    workspaceName: organizationUrlKey,
    identifier: 'STA-4084',
    title: 'Restore shell integration',
    url: `https://linear.app/${organizationUrlKey}/issue/STA-4084/restore-shell-integration`,
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-sta', name: 'Stably', key: 'STA' },
    labels: [],
    labelIds: [],
    priority: 2,
    updatedAt: '2026-08-12T00:00:00.000Z'
  }
}

describe('Linear issue URL lookup', () => {
  it('refreshes status from the source owner when the known workspace is stale', async () => {
    const fetchLinearIssue = vi.fn((_identifier: string, workspaceId?: string | null) =>
      linearIssueReadFixture<LinearIssue | null>(async () =>
        workspaceId === 'remote-stably-workspace' ? issue() : null
      )
    )

    await expect(
      readLinearIssueForTest(
        lookupLinearIssueUrl({
          intent,
          knownStatus: {
            viewer: null,
            workspaces: [{ id: 'stale-workspace', organizationUrlKey: 'stably' } as never]
          },
          sourceContext: null,
          fetchLinearIssue,
          readLinearStatus: async () => ({
            connected: true,
            viewer: null,
            workspaces: [
              {
                id: 'remote-stably-workspace',
                organizationUrlKey: 'stably'
              } as never
            ]
          })
        })
      )
    ).resolves.toMatchObject({ workspaceId: 'stably-workspace' })
    expect(fetchLinearIssue).toHaveBeenCalledTimes(2)
  })
})
