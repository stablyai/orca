import { describe, expect, it } from 'vitest'
import type { AzureDevOpsBacklogLevel } from '../../../shared/azure-devops/boards-types'
import {
  azureDevOpsTeamSelectionKey,
  pickDefaultAzureDevOpsLevel
} from './use-task-page-azure-devops-state'
import {
  listVisibleAzureDevOpsLevels,
  resolveAzureDevOpsLoadFailure
} from './task-page-azure-devops-backlog-level-selection'

function level(
  id: string,
  kind: AzureDevOpsBacklogLevel['kind'],
  hidden = false
): AzureDevOpsBacklogLevel {
  return { id, name: id, rank: 0, kind, workItemTypes: [], columnFields: [], hidden }
}

describe('azure-devops task page decisions', () => {
  it('keys the team selection by organization and project, with a collection fallback', () => {
    expect(azureDevOpsTeamSelectionKey({ organization: 'acme', project: 'Project' })).toBe(
      'acme/Project'
    )
    expect(azureDevOpsTeamSelectionKey({ organization: null, project: 'MyProject' })).toBe(
      'collection/MyProject'
    )
  })

  it('defaults to the visible requirement level, else the first visible level', () => {
    expect(
      pickDefaultAzureDevOpsLevel([
        level('epic', 'portfolio', true),
        level('feat', 'portfolio'),
        level('req', 'requirement')
      ])?.id
    ).toBe('req')
    expect(
      pickDefaultAzureDevOpsLevel([
        level('epic', 'portfolio', true),
        level('feat', 'portfolio'),
        level('req', 'requirement', true)
      ])?.id
    ).toBe('feat')
    expect(pickDefaultAzureDevOpsLevel([level('epic', 'portfolio', true)])).toBeNull()
  })

  it('never lists the task backlog: the Backlogs hub shows portfolio and requirement levels only', () => {
    expect(
      listVisibleAzureDevOpsLevels([
        level('feat', 'portfolio'),
        level('req', 'requirement'),
        level('task', 'task')
      ]).map((l) => l.id)
    ).toEqual(['feat', 'req'])
    expect(pickDefaultAzureDevOpsLevel([level('task', 'task')])).toBeNull()
  })

  it('maps the repo-resolution error codes to distinct statuses and keeps the message otherwise', () => {
    expect(resolveAzureDevOpsLoadFailure(new Error('azure_devops_remote_required'))).toEqual({
      status: 'not-azure-remote',
      message: 'azure_devops_remote_required'
    })
    expect(resolveAzureDevOpsLoadFailure(new Error('azure_devops_repo_unverifiable'))).toEqual({
      status: 'host-unreachable',
      message: 'azure_devops_repo_unverifiable'
    })
    expect(resolveAzureDevOpsLoadFailure(new Error('HTTP 403'))).toEqual({
      status: 'error',
      message: 'HTTP 403'
    })
  })
})
