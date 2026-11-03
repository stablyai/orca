import { describe, expect, it } from 'vitest'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogViewSettings
} from '../../../shared/azure-devops/boards-types'
import {
  applyAzureDevOpsColumnWidths,
  azureDevOpsColumnWidthKey,
  resolveAzureDevOpsBacklogColumns
} from './task-page-azure-devops-backlog-columns'

const level: AzureDevOpsBacklogLevel = {
  id: 'Microsoft.RequirementCategory',
  name: 'Backlog items',
  rank: 2,
  kind: 'requirement',
  workItemTypes: ['Product Backlog Item'],
  columnFields: [
    { referenceName: 'System.WorkItemType', name: 'Work Item Type', width: 100 },
    { referenceName: 'System.Title', name: 'Title', width: 400 },
    { referenceName: 'System.State', name: 'State', width: 100 },
    { referenceName: 'Microsoft.VSTS.Scheduling.Effort', name: 'Effort', width: 50 }
  ],
  hidden: false
}

function settings(
  columns: AzureDevOpsBacklogViewSettings['columnOptionsByLevel']
): AzureDevOpsBacklogViewSettings {
  return {
    columnOptionsByLevel: columns,
    showParents: null,
    inProgressFilter: null,
    savedFiltersByLevel: {}
  }
}

describe('resolveAzureDevOpsBacklogColumns', () => {
  it('prefers the user column options for the level and drops the type column', () => {
    const columns = resolveAzureDevOpsBacklogColumns(
      level,
      settings({
        [level.id]: [
          { referenceName: 'System.WorkItemType', name: 'Work Item Type', width: 100 },
          { referenceName: 'System.Title', name: 'Title', width: 320 },
          { referenceName: 'System.Parent', name: 'Parent', width: 200 },
          { referenceName: 'System.Parent', name: 'Parent again', width: 10 }
        ]
      })
    )
    expect(columns).toEqual([
      { referenceName: 'System.Title', name: 'Title', width: 320 },
      { referenceName: 'System.Parent', name: 'Parent', width: 200 }
    ])
  })

  it('falls back to the process columns when the user saved none for this level', () => {
    const columns = resolveAzureDevOpsBacklogColumns(
      level,
      settings({ 'Microsoft.FeatureCategory': [{ referenceName: 'X', name: 'X', width: 1 }] })
    )
    expect(columns.map((c) => c.referenceName)).toEqual([
      'System.Title',
      'System.State',
      'Microsoft.VSTS.Scheduling.Effort'
    ])
  })

  it('falls back to Title and State when neither source has columns', () => {
    expect(
      resolveAzureDevOpsBacklogColumns({ ...level, columnFields: [] }, null).map(
        (c) => c.referenceName
      )
    ).toEqual(['System.Title', 'System.State'])
    expect(resolveAzureDevOpsBacklogColumns(null, undefined).map((c) => c.name)).toEqual([
      'Title',
      'State'
    ])
  })

  it('always keeps a Title column even if the user removed it', () => {
    const columns = resolveAzureDevOpsBacklogColumns(
      level,
      settings({ [level.id]: [{ referenceName: 'System.State', name: 'State', width: 90 }] })
    )
    expect(columns.map((c) => c.referenceName)).toEqual(['System.Title', 'System.State'])
  })
})

describe('applyAzureDevOpsColumnWidths', () => {
  it('lets a local override win over the ADO width and clamps to the minimum', () => {
    const columns = applyAzureDevOpsColumnWidths(
      [
        { referenceName: 'System.Title', name: 'Title', width: 400 },
        { referenceName: 'System.State', name: 'State', width: 100 },
        { referenceName: 'System.Tags', name: 'Tags', width: 200 }
      ],
      { 'System.Title': 250.4, 'System.State': 5 }
    )
    expect(columns.map((c) => c.width)).toEqual([250, 60, 200])
  })
})

describe('azureDevOpsColumnWidthKey', () => {
  it('scopes to project, team and level', () => {
    expect(
      azureDevOpsColumnWidthKey({ organization: 'acme', project: 'P' }, 'Mobile', level.id)
    ).toBe('acme/P::Mobile::Microsoft.RequirementCategory')
    expect(azureDevOpsColumnWidthKey({ organization: null, project: 'P' }, 'T', 'L')).toBe(
      '/P::T::L'
    )
  })
})
