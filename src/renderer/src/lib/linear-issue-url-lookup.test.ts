import {
  linearIssueReadFixture,
  readLinearIssueForTest
} from '@/store/slices/linear-slice-test-harness'
import { describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../shared/linear/issue-types'

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

  it('uses legacy viewer status when mixed versions omit the workspace list', async () => {
    const fetchLinearIssue = vi.fn(() =>
      linearIssueReadFixture<LinearIssue | null>(async () => issue())
    )

    await expect(
      readLinearIssueForTest(
        lookupLinearIssueUrl({
          intent,
          knownStatus: {
            viewer: {
              displayName: 'Linear User',
              email: null,
              organizationName: 'Stably',
              organizationUrlKey: 'stably'
            },
            activeWorkspaceId: 'legacy-workspace'
          },
          sourceContext: null,
          fetchLinearIssue,
          readLinearStatus: vi.fn()
        })
      )
    ).resolves.toMatchObject({ identifier: 'STA-4084' })
    expect(fetchLinearIssue).toHaveBeenCalledWith('STA-4084', 'legacy-workspace', {
      sourceContext: null
    })
  })

  it('probes a legacy workspace that omitted its organization URL key', async () => {
    const fetchLinearIssue = vi.fn(() =>
      linearIssueReadFixture<LinearIssue | null>(async () => issue())
    )

    await expect(
      readLinearIssueForTest(
        lookupLinearIssueUrl({
          intent,
          knownStatus: {
            viewer: {
              displayName: 'Linear User',
              email: null,
              organizationName: 'Saved Linear workspace'
            },
            activeWorkspaceId: 'legacy',
            selectedWorkspaceId: 'legacy',
            workspaces: [{ id: 'legacy', organizationName: 'Saved Linear workspace' } as never]
          },
          sourceContext: null,
          fetchLinearIssue,
          readLinearStatus: vi.fn()
        })
      )
    ).resolves.toMatchObject({ identifier: 'STA-4084' })
    expect(fetchLinearIssue).toHaveBeenCalledWith('STA-4084', 'legacy', {
      sourceContext: null
    })
  })

  it('does not fall back to an all-workspaces lookup that can collide across organizations', async () => {
    const fetchLinearIssue = vi.fn(() =>
      linearIssueReadFixture<LinearIssue | null>(async () => issue('other'))
    )

    await expect(
      readLinearIssueForTest(
        lookupLinearIssueUrl({
          intent,
          knownStatus: {
            viewer: null,
            workspaces: [{ id: 'other-workspace', organizationUrlKey: 'other' } as never]
          },
          sourceContext: null,
          fetchLinearIssue,
          readLinearStatus: async () => ({
            connected: true,
            viewer: null,
            workspaces: [{ id: 'other-workspace', organizationUrlKey: 'other' } as never]
          })
        })
      )
    ).resolves.toBeNull()
    expect(fetchLinearIssue).not.toHaveBeenCalled()
  })
})
