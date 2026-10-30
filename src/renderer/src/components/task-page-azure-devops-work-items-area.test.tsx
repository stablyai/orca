// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { AzureDevOpsWorkItem } from '../../../shared/azure-devops/boards-types'
import { AzureDevOpsWorkItemsArea } from '@/components/task-page/azure-devops/Content'
import type { AzureDevOpsContentProps } from '@/components/use-task-page-azure-devops-state'
import {
  azureDevOpsWorkItemColumns,
  buildAzureDevOpsWorkItemRows
} from './task-page-azure-devops-work-item-rows'

afterEach(() => cleanup())

function item(id: number, overrides: Partial<AzureDevOpsWorkItem> = {}): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'Bug',
    title: `Item ${id}`,
    state: 'Active',
    assignedTo: null,
    areaPath: 'Project\\Other',
    iterationPath: 'Project',
    tags: [],
    parentId: null,
    stackRank: null,
    url: `https://dev.azure.com/acme/_workitems/edit/${id}`,
    fields: {
      'System.AreaPath': 'Project\\Other',
      'System.ChangedDate': '2026-10-30T02:00:00Z'
    },
    ...overrides
  }
}

function area(
  overrides: Partial<AzureDevOpsContentProps['workItems']> = {}
): AzureDevOpsContentProps['workItems'] {
  const items = [item(7), item(3)]
  return {
    table: {
      rows: buildAzureDevOpsWorkItemRows(items),
      columnFields: azureDevOpsWorkItemColumns(),
      workItemTypes: {},
      tagColors: {},
      itemById: new Map(items.map((i) => [i.id, i])),
      onToggleExpand: vi.fn(),
      onOpenItem: vi.fn(),
      onUseItem: vi.fn()
    },
    totalItemCount: items.length,
    unhydratedItemCount: 0,
    errorStatus: null,
    errorMessage: null,
    loading: false,
    ...overrides
  }
}

describe('AzureDevOpsWorkItemsArea', () => {
  it('lists the items flat, in the order the query returned, with the area path shown', () => {
    render(<AzureDevOpsWorkItemsArea {...area()} />)
    const titles = screen.getAllByText(/^Item \d$/).map((n) => n.textContent)
    expect(titles).toEqual(['Item 7', 'Item 3'])
    expect(screen.getByText('Area Path')).toBeInTheDocument()
    expect(screen.getAllByText('Project\\Other')).toHaveLength(2)
  })

  it('says nothing is assigned rather than showing the filter-miss message', () => {
    render(
      <AzureDevOpsWorkItemsArea
        {...area({ table: { ...area().table, rows: [] }, totalItemCount: 0 })}
      />
    )
    expect(
      screen.getByText(/No work items in this project are assigned to you/)
    ).toBeInTheDocument()
  })

  it('counts the items the host could not hydrate, reusing the backlog notice', () => {
    render(<AzureDevOpsWorkItemsArea {...area({ unhydratedItemCount: 2 })} />)
    expect(screen.getByText(/2 work items couldn’t be loaded/)).toBeInTheDocument()
  })

  it('shows the host-unreachable notice, not a raw message, when contact was lost', () => {
    render(
      <AzureDevOpsWorkItemsArea
        {...area({
          errorStatus: 'host-unreachable',
          errorMessage: 'azure_devops_repo_unverifiable'
        })}
      />
    )
    expect(screen.getByText(/Couldn’t reach the host/)).toBeInTheDocument()
    expect(screen.queryByText(/azure_devops_repo_unverifiable/)).toBeNull()
  })

  it('reports an ordinary failure with its message instead of an empty list', () => {
    render(
      <AzureDevOpsWorkItemsArea {...area({ errorStatus: 'error', errorMessage: 'HTTP 500' })} />
    )
    expect(
      screen.getByText(/Couldn’t load your Azure DevOps work items: HTTP 500/)
    ).toBeInTheDocument()
  })

  it('spins only while the first load has no rows yet', () => {
    const { container } = render(
      <AzureDevOpsWorkItemsArea
        {...area({ loading: true, table: { ...area().table, rows: [] } })}
      />
    )
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })
})
