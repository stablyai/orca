// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type {
  AzureDevOpsBoardConfiguration,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import {
  AzureDevOpsBoard,
  BOARD_CARD_ESTIMATED_HEIGHT_PX,
  BOARD_CARD_STACK_MIN_ROWS,
  type AzureDevOpsBoardProps
} from '@/components/task-page/azure-devops/Board'
import { buildAzureDevOpsBoardLayout } from './task-page-azure-devops-board-layout'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Cards stub out at the estimate, so the spacer must reserve the whole stack whatever the estimate is.
const BOARD_CARD_HEIGHT_PX = BOARD_CARD_ESTIMATED_HEIGHT_PX
const BOARD_VIEWPORT_HEIGHT_PX = 600

/** happy-dom has no layout, and a zero-height scroller windows every stack down to nothing. */
function stubBoardLayout(): void {
  const heightOf = (element: Element): number =>
    element.classList.contains('overflow-auto') ? BOARD_VIEWPORT_HEIGHT_PX : BOARD_CARD_HEIGHT_PX
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return heightOf(this)
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(0, 0, 240, heightOf(this))
  })
}

const COLUMN_FIELD = 'WEF_1_Kanban.Column'
const LANE_FIELD = 'WEF_1_Kanban.Lane'
const DONE_FIELD = 'WEF_1_Kanban.Column.Done'

const workItemTypes: AzureDevOpsWorkItemTypeMetadata[] = [
  {
    name: 'Product Backlog Item',
    color: '#009CCC',
    iconId: 'icon_list',
    iconUrl: null,
    states: [{ name: 'Approved', color: '#b2b2b2', category: 'Proposed' }]
  }
]

function configuration(
  overrides: Partial<AzureDevOpsBoardConfiguration> = {}
): AzureDevOpsBoardConfiguration {
  return {
    id: 'board-1',
    name: 'Stories',
    columns: [
      {
        id: 'c1',
        name: 'New',
        columnType: 'incoming',
        itemLimit: 0,
        isSplit: false,
        stateMappings: {},
        description: null
      },
      {
        id: 'c2',
        name: 'Active',
        columnType: 'inProgress',
        itemLimit: 2,
        isSplit: false,
        stateMappings: {},
        description: null
      },
      {
        id: 'c3',
        name: 'Resolved',
        columnType: 'inProgress',
        itemLimit: 5,
        isSplit: true,
        stateMappings: {},
        description: null
      },
      {
        id: 'c4',
        name: 'Closed',
        columnType: 'outgoing',
        itemLimit: 0,
        isSplit: false,
        stateMappings: {},
        description: null
      }
    ],
    rows: [
      { id: 'r1', name: 'Expedite', color: '#FF6666', isDefault: false },
      { id: 'r2', name: '', color: null, isDefault: true }
    ],
    columnField: COLUMN_FIELD,
    rowField: LANE_FIELD,
    doneField: DONE_FIELD,
    cardFields: {
      'Product Backlog Item': {
        fields: [{ referenceName: 'System.Title', core: true }],
        showEmptyFields: false
      }
    },
    tagColors: {},
    styleRules: [],
    ...overrides
  }
}

function item(
  id: number,
  fields: Record<string, unknown>,
  overrides: Partial<AzureDevOpsWorkItem> = {}
): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'Product Backlog Item',
    title: `Item ${id}`,
    state: 'Approved',
    assignedTo: null,
    areaPath: 'Project\\Web',
    iterationPath: 'Project',
    tags: [],
    parentId: null,
    stackRank: id,
    url: '',
    fields: { 'System.Title': `Item ${id}`, ...fields },
    ...overrides
  }
}

const defaultItems = [
  item(101, { [COLUMN_FIELD]: 'Active', [LANE_FIELD]: 'Expedite' }),
  item(102, { [COLUMN_FIELD]: 'Active' }),
  item(103, { [COLUMN_FIELD]: 'New' }),
  item(104, { [COLUMN_FIELD]: 'Resolved', [DONE_FIELD]: true }),
  item(105, { [COLUMN_FIELD]: 'Closed' })
]

function renderBoard(
  overrides: Partial<AzureDevOpsBoardProps> = {},
  input: { configuration?: AzureDevOpsBoardConfiguration; items?: AzureDevOpsWorkItem[] } = {}
) {
  const config = input.configuration ?? configuration()
  const layout = buildAzureDevOpsBoardLayout({
    configuration: config,
    items: input.items ?? defaultItems,
    workItemTypes
  })
  const props: AzureDevOpsBoardProps = {
    layout,
    configuration: config,
    workItemTypes,
    parentsById: {},
    unhydratedItemCount: 0,
    unhydratedParentCount: 0,
    collapsedLaneIds: new Set<string>(),
    onToggleLane: vi.fn(),
    onOpenItem: vi.fn(),
    onUseItem: vi.fn(),
    ...overrides
  }
  return { ...render(<AzureDevOpsBoard {...props} />), props }
}

function columnHeader(container: HTMLElement, columnId: string): Element {
  const header = container.querySelector(`[data-board-column="${columnId}"]`)
  expect(header).not.toBeNull()
  return header!
}

describe('AzureDevOpsBoard', () => {
  it('renders columns in configuration order with their WIP counters', () => {
    const { container } = renderBoard()
    const names = [...container.querySelectorAll('[data-board-column-name]')].map(
      (node) => node.textContent
    )
    expect(names).toEqual(['New', 'Active', 'Resolved', 'Closed'])
    expect(columnHeader(container, 'c2').querySelector('[data-board-wip]')).toHaveTextContent(
      '2 / 2'
    )
    expect(columnHeader(container, 'c3').querySelector('[data-board-wip]')).toHaveTextContent(
      '1 / 5'
    )
  })

  it('omits the counter for a column with no limit', () => {
    const { container } = renderBoard()
    expect(columnHeader(container, 'c1').querySelector('[data-board-wip]')).toBeNull()
    expect(columnHeader(container, 'c4').querySelector('[data-board-wip]')).toBeNull()
  })

  it('marks a column over its limit', () => {
    const { container } = renderBoard(
      {},
      { items: [...defaultItems, item(106, { [COLUMN_FIELD]: 'Active' })] }
    )
    const counter = columnHeader(container, 'c2').querySelector('[data-board-wip]')
    expect(counter).toHaveAttribute('data-over-limit', 'true')
    expect(counter).toHaveClass('text-destructive')
    const within = columnHeader(container, 'c3').querySelector('[data-board-wip]')
    expect(within).toHaveAttribute('data-over-limit', 'false')
    expect(within).toHaveClass('text-status-success')
  })

  it('renders Doing and Done sub-columns for a split column', () => {
    const { container } = renderBoard()
    const subs = [...container.querySelectorAll('[data-board-subcolumn]')]
    expect(subs.map((node) => node.getAttribute('data-board-subcolumn'))).toEqual([
      'c3|doing',
      'c3|done'
    ])
    expect(subs[0]).toHaveTextContent('Doing')
    expect(subs[1]).toHaveTextContent('Done')
  })

  it('renders one section per lane with the lane name', () => {
    const { container } = renderBoard()
    const lanes = [...container.querySelectorAll('[data-board-lane]')]
    expect(lanes.map((node) => node.getAttribute('data-board-lane'))).toEqual(['r1', 'r2'])
    expect(lanes[0]).toHaveTextContent('Expedite')
    expect(lanes[1]).toHaveTextContent('Default')
    expect(screen.getByText('Item 101')).toBeInTheDocument()
    expect(screen.getByText('Item 102')).toBeInTheDocument()
  })

  it('renders a collapsed lane as a header with per-column counts for non-empty columns', () => {
    const { container } = renderBoard({ collapsedLaneIds: new Set(['r1']) })
    const counts = container.querySelector('[data-board-lane-counts="r1"]')
    expect(counts).not.toBeNull()
    expect(counts).toHaveTextContent('Active')
    expect(counts).toHaveTextContent('1')
    expect(counts?.querySelector('[data-board-lane-count="c3"]')).toBeNull()
    expect(screen.queryByText('Item 101')).toBeNull()
    expect(screen.getByText('Item 102')).toBeInTheDocument()
  })

  it('leaves incoming and outgoing columns out of a collapsed default lane', () => {
    // Those cards live under the default lane but stay visible in their spanning stacks.
    const { container } = renderBoard({ collapsedLaneIds: new Set(['r2']) })
    const counts = container.querySelector('[data-board-lane-counts="r2"]')
    expect(counts?.querySelector('[data-board-lane-count="c2"]')).not.toBeNull()
    expect(counts?.querySelector('[data-board-lane-count="c1"]')).toBeNull()
    expect(counts?.querySelector('[data-board-lane-count="c4"]')).toBeNull()
    expect(screen.getByText('Item 103')).toBeInTheDocument()
    expect(screen.getByText('Item 105')).toBeInTheDocument()
  })

  it('calls onToggleLane with the lane id when the toggle is pressed', () => {
    const { container, props } = renderBoard()
    const toggle = container.querySelector('[data-board-lane="r1"] button')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle!)
    expect(props.onToggleLane).toHaveBeenCalledWith('r1')
  })

  it('renders incoming and outgoing columns as a single stack', () => {
    const { container } = renderBoard()
    const incoming = [...container.querySelectorAll('[data-board-cell^="c1|"]')]
    expect(incoming).toHaveLength(1)
    expect(incoming[0]).toHaveAttribute('data-board-span', 'lanes')
    expect(incoming[0]).toHaveTextContent('Item 103')
    const outgoing = [...container.querySelectorAll('[data-board-cell^="c4|"]')]
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]).toHaveTextContent('Item 105')
    // In-progress cells stay per lane.
    expect(container.querySelectorAll('[data-board-cell^="c2|"]')).toHaveLength(2)
  })

  it('names how many cards are not mapped to a column and marks each one', () => {
    // 'Triage' matches no column name and no state mapping, so rule 4 parks it in Active.
    const { container } = renderBoard(
      {},
      { items: [...defaultItems, item(107, { [COLUMN_FIELD]: 'Triage' })] }
    )
    const notice = container.querySelector('[data-board-notice="unmapped"]')
    expect(notice).not.toBeNull()
    expect(notice).toHaveTextContent('1 card is not mapped to a column')
    const marked = [...container.querySelectorAll('[data-board-card-unplaced]')]
    expect(marked).toHaveLength(1)
    expect(marked[0].closest('[data-board-card]')).toHaveAttribute('data-board-card', '107')
    expect(marked[0]).toHaveAttribute('title', expect.stringContaining('not mapped to a column'))
    expect(container.querySelector('[data-board-card="101"] [data-board-card-unplaced]')).toBeNull()
  })

  it('shows no notices when every card is mapped and nothing is missing', () => {
    const { container } = renderBoard()
    expect(container.querySelector('[data-board-notices]')).toBeNull()
  })

  it('names the cards and parents the host could not load', () => {
    const { container } = renderBoard({ unhydratedItemCount: 2, unhydratedParentCount: 1 })
    expect(container.querySelector('[data-board-notice="unhydrated-items"]')).toHaveTextContent(
      '2 cards couldn’t be loaded'
    )
    expect(container.querySelector('[data-board-notice="unhydrated-parents"]')).toHaveTextContent(
      '1 parent work item couldn’t be loaded'
    )
  })

  it('keeps a short stack in natural flow', () => {
    const { container } = renderBoard()
    expect(container.querySelector('[data-testid="virtualized-list"]')).toBeNull()
    expect(container.querySelectorAll('[data-board-card]')).toHaveLength(defaultItems.length)
  })

  it('windows a stack past the threshold while short stacks stay whole', () => {
    stubBoardLayout()
    const crowd = Array.from({ length: BOARD_CARD_STACK_MIN_ROWS * 3 }, (_, index) =>
      item(200 + index, { [COLUMN_FIELD]: 'New' })
    )
    const { container } = renderBoard({}, { items: [...defaultItems, ...crowd] })
    const incoming = container.querySelector('[data-board-cell^="c1|"]')
    const windowed = incoming?.querySelector('[data-testid="virtualized-list"]')
    expect(windowed).not.toBeNull()
    const stackSize = crowd.length + 1
    const mounted = incoming!.querySelectorAll('[data-board-card]').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(stackSize / 2)
    // The spacer still reserves every card's height, so the board keeps its full scroll range.
    expect(windowed).toHaveStyle({ height: `${stackSize * BOARD_CARD_HEIGHT_PX}px` })
    // The in-progress lanes stay under the threshold, so their cards are all still mounted.
    expect(screen.getByText('Item 101')).toBeInTheDocument()
    expect(screen.getByText('Item 102')).toBeInTheDocument()
  })

  it('calls onOpenItem with the work item id when a card is clicked', () => {
    const { container, props } = renderBoard()
    const card = container.querySelector('[data-board-card="101"]')
    expect(card).not.toBeNull()
    fireEvent.click(card!)
    expect(props.onOpenItem).toHaveBeenCalledWith(101)
  })
})
