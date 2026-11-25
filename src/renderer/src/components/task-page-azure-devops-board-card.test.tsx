// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type {
  AzureDevOpsBoardCardField,
  AzureDevOpsBoardConfiguration,
  AzureDevOpsBoardStyleRule,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import {
  AzureDevOpsBoardCard,
  type AzureDevOpsBoardCardProps
} from '@/components/task-page/azure-devops/BoardCard'

afterEach(() => cleanup())

const TYPE = 'Product Backlog Item'

const typeMetadata: AzureDevOpsWorkItemTypeMetadata = {
  name: TYPE,
  color: '#009CCC',
  iconId: 'icon_list',
  iconUrl: null,
  states: [{ name: 'Approved', color: '#b2b2b2', category: 'Proposed' }]
}

function workItem(overrides: Partial<AzureDevOpsWorkItem> = {}): AzureDevOpsWorkItem {
  return {
    id: 42,
    rev: 1,
    workItemType: TYPE,
    title: 'Publish the release notes',
    state: 'Approved',
    assignedTo: { displayName: 'Ada Lovelace', uniqueName: 'ada@contoso.com', imageUrl: null },
    areaPath: 'Project\\Web',
    iterationPath: 'Project\\Sprint 1',
    tags: [],
    parentId: null,
    stackRank: 1,
    url: '',
    fields: {
      'System.Title': 'Publish the release notes',
      'System.State': 'Approved',
      'System.AssignedTo': { displayName: 'Ada Lovelace', uniqueName: 'ada@contoso.com' },
      'Microsoft.VSTS.Scheduling.Effort': 5
    },
    ...overrides
  }
}

function configuration(input: {
  fields: AzureDevOpsBoardCardField[]
  showEmptyFields?: boolean
  tagColors?: Record<string, string>
  styleRules?: AzureDevOpsBoardStyleRule[]
}): AzureDevOpsBoardConfiguration {
  return {
    id: 'board-1',
    name: 'Stories',
    columns: [],
    rows: [],
    columnField: 'WEF_1_Kanban.Column',
    rowField: 'WEF_1_Kanban.Lane',
    doneField: 'WEF_1_Kanban.Column.Done',
    cardFields: {
      [TYPE]: { fields: input.fields, showEmptyFields: input.showEmptyFields ?? false }
    },
    tagColors: input.tagColors ?? {},
    styleRules: input.styleRules ?? []
  }
}

function renderCard(overrides: Partial<AzureDevOpsBoardCardProps> = {}) {
  const props: AzureDevOpsBoardCardProps = {
    item: workItem(),
    configuration: configuration({ fields: [{ referenceName: 'System.Title', core: true }] }),
    typeMetadata,
    parent: null,
    onOpen: vi.fn(),
    onUse: vi.fn(),
    ...overrides
  }
  return { ...render(<AzureDevOpsBoardCard {...props} />), props }
}

function cardRoot(container: HTMLElement): Element {
  const root = container.querySelector('[data-board-card]')
  expect(root).not.toBeNull()
  return root!
}

describe('AzureDevOpsBoardCard', () => {
  it('always renders the title and the type icon', () => {
    // The card settings list no title field, yet ADO always paints it.
    const { container } = renderCard({
      configuration: configuration({ fields: [{ referenceName: 'System.State', core: true }] })
    })
    expect(screen.getByText('Publish the release notes')).toBeInTheDocument()
    expect(container.querySelector('[data-board-card-id]')).toHaveTextContent('42')
    // Scoped to the header: a bare `svg` query also matches the Use button's glyph.
    const icon = container.querySelector(
      `[data-board-card-header] [data-board-card-type="${TYPE}"]`
    )
    expect(icon).not.toBeNull()
    expect(icon?.querySelector('svg')).not.toBeNull()
  })

  it('calls onUse without opening the item when Use is pressed', () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByText('Use'))
    expect(props.onUse).toHaveBeenCalledTimes(1)
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('renders only the fields the card settings list, in their order', () => {
    const { container } = renderCard({
      item: workItem({
        tags: ['triage'],
        fields: {
          ...workItem().fields,
          'System.Tags': 'triage',
          'Microsoft.VSTS.Common.Priority': 2
        }
      }),
      configuration: configuration({
        fields: [
          { referenceName: 'System.Title', core: true },
          { referenceName: 'Microsoft.VSTS.Common.Priority', core: false },
          { referenceName: 'System.State', core: true },
          { referenceName: 'System.Tags', core: true },
          { referenceName: 'System.AssignedTo', core: true }
        ]
      })
    })
    const rendered = [...container.querySelectorAll('[data-card-field]')].map((node) =>
      node.getAttribute('data-card-field')
    )
    expect(rendered).toEqual([
      'Microsoft.VSTS.Common.Priority',
      'System.State',
      'System.Tags',
      'System.AssignedTo'
    ])
    expect(
      container.querySelector('[data-card-field="Microsoft.VSTS.Scheduling.Effort"]')
    ).toBeNull()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('hides an empty field when showEmptyFields is false and shows it when true', () => {
    const fields = [
      { referenceName: 'System.Title', core: true },
      { referenceName: 'Microsoft.VSTS.Scheduling.Effort', core: true }
    ]
    const item = workItem({ fields: { 'System.Title': 'Publish the release notes' } })
    const hidden = renderCard({ item, configuration: configuration({ fields }) })
    expect(
      hidden.container.querySelector('[data-card-field="Microsoft.VSTS.Scheduling.Effort"]')
    ).toBeNull()
    cleanup()
    const shown = renderCard({
      item,
      configuration: configuration({ fields, showEmptyFields: true })
    })
    expect(
      shown.container.querySelector('[data-card-field="Microsoft.VSTS.Scheduling.Effort"]')
    ).not.toBeNull()
  })

  it('renders the parent’s title for System.Parent', () => {
    renderCard({
      item: workItem({ parentId: 7, fields: { 'System.Title': 'Child', 'System.Parent': 7 } }),
      parent: workItem({ id: 7, workItemType: 'Feature', title: 'Release 1.0' }),
      configuration: configuration({ fields: [{ referenceName: 'System.Parent', core: true }] })
    })
    expect(screen.getByText('Release 1.0')).toBeInTheDocument()
  })

  it('renders the parent type’s own icon for System.Parent', () => {
    const parentMetadata = (name: string, iconId: string): AzureDevOpsWorkItemTypeMetadata => ({
      name,
      color: '#773B93',
      iconId,
      iconUrl: `https://contoso.example/_apis/wit/workItemIcons/${iconId}`,
      states: []
    })
    const renderParent = (name: string, iconId: string) =>
      renderCard({
        item: workItem({ parentId: 7, fields: { 'System.Title': 'Child', 'System.Parent': 7 } }),
        parent: workItem({ id: 7, workItemType: name, title: 'Release 1.0' }),
        parentTypeMetadata: parentMetadata(name, iconId),
        configuration: configuration({ fields: [{ referenceName: 'System.Parent', core: true }] })
      })
    const feature = renderParent('Feature', 'icon_trophy')
    expect(
      feature.container.querySelector('[data-card-parent-type="Feature"] img')
    ).toHaveAttribute('src', 'https://contoso.example/_apis/wit/workItemIcons/icon_trophy')
    cleanup()
    const bug = renderParent('Bug', 'icon_insect')
    expect(bug.container.querySelector('[data-card-parent-type="Bug"] img')).toHaveAttribute(
      'src',
      'https://contoso.example/_apis/wit/workItemIcons/icon_insect'
    )
  })

  it('colours a tag chip from the board’s tag colours and leaves an unmatched tag default', () => {
    const { container } = renderCard({
      item: workItem({ tags: ['triage', 'later'], fields: { 'System.Tags': 'triage; later' } }),
      configuration: configuration({
        fields: [{ referenceName: 'System.Tags', core: true }],
        tagColors: { triage: '#FFB900' }
      })
    })
    const chips = [...container.querySelectorAll('[data-card-field="System.Tags"] span')]
    const triage = chips.find((node) => node.textContent === 'triage')
    const later = chips.find((node) => node.textContent === 'later')
    expect(triage).toHaveStyle({ backgroundColor: '#FFB900' })
    expect(later).toHaveClass('bg-muted')
  })

  it('applies a matching style rule’s background and title colours', () => {
    const { container } = renderCard({
      item: workItem({ fields: { 'System.Title': 'Blocked work', 'System.Tags': 'blocked' } }),
      configuration: configuration({
        fields: [{ referenceName: 'System.Title', core: true }],
        styleRules: [
          {
            name: 'Blocked',
            clauses: [
              {
                fieldName: 'System.Tags',
                operator: 'contains',
                value: 'blocked',
                logicalOperator: null
              }
            ],
            backgroundColor: '#FFF59D',
            titleColor: '#C00000'
          }
        ]
      })
    })
    expect(cardRoot(container)).toHaveStyle({ backgroundColor: '#FFF59D' })
    expect(container.querySelector('[data-board-card-title]')).toHaveStyle({ color: '#C00000' })
  })

  function styledCard(backgroundColor: string) {
    return renderCard({
      item: workItem({ fields: { 'System.Title': 'Styled', 'System.Tags': 'blocked' } }),
      configuration: configuration({
        fields: [{ referenceName: 'System.Title', core: true }],
        styleRules: [
          {
            name: 'Blocked',
            clauses: [
              {
                fieldName: 'System.Tags',
                operator: 'contains',
                value: 'blocked',
                logicalOperator: null
              }
            ],
            backgroundColor,
            titleColor: null
          }
        ]
      })
    })
  }

  it('keeps card text readable against a light style-rule fill in dark mode', () => {
    const light = styledCard('#FFF59D')
    expect(cardRoot(light.container)).toHaveClass('text-black')
    cleanup()
    const dark = styledCard('#1F3A5F')
    expect(cardRoot(dark.container)).toHaveClass('text-white')
  })

  it('renders no style when no rule matches', () => {
    const { container } = renderCard()
    const root = cardRoot(container)
    expect(root).toHaveStyle({ backgroundColor: '' })
    expect(root).not.toHaveClass('text-black')
    expect(root).not.toHaveClass('text-white')
  })
})
