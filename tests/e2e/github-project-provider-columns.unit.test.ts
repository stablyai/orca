// @vitest-environment happy-dom

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeItem,
  type RawItem
} from '../../src/main/github/project-view/project-view-item-normalization'
import { fetchItemsPageWithRaw } from '../../src/main/github/project-view/project-view-item-page'
import { fetchAllItems } from '../../src/main/github/project-view/project-view-items'
import {
  _resetProjectViewCachesForTests,
  type OptionalProjectItemField
} from '../../src/main/github/project-view/project-view-cache'
import { ghExecFileAsync } from '../../src/main/github/project-view/internals'
import type { GitHubProjectRow, GitHubProjectTable } from '../../src/shared/github/project-types'
import { sortRows, groupRows } from '../../src/shared/github/project-group-sort'
import * as fieldNormalization from '../../src/main/github/project-view/project-view-field-normalization'
import ProjectCell from '../../src/renderer/src/components/github-project/ProjectCell'

vi.mock('../../src/main/github/project-view/internals', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: vi.fn(),
  projectHostAuthenticationError: vi.fn().mockResolvedValue(null),
  projectGhExecOptions: (host?: string) => ({ host }),
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))
vi.mock('../../src/main/github/project-view/project-view-config', () => ({
  ownerQueryRoot: () => 'organization'
}))

const parent = { number: 10, title: 'Parent', url: 'https://github.com/o/r/issues/10' }
const item: RawItem = {
  id: 'item-1',
  type: 'ISSUE',
  content: {
    __typename: 'Issue',
    number: 42,
    title: 'Issue',
    parent,
    subIssuesSummary: { completed: 1, total: 2, percentCompleted: 50 }
  },
  fieldValues: {
    nodes: [
      {
        __typename: 'ProjectV2ItemFieldPullRequestValue',
        field: { id: 'field-pr', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
        pullRequests: {
          totalCount: 12,
          nodes: Array.from({ length: 10 }, (_, index) => ({
            number: index + 1,
            title: `Change ${index + 1}`,
            url: `https://github.com/o/r/pull/${index + 1}`
          }))
        }
      }
    ]
  }
}
const args = {
  owner: 'o',
  ownerType: 'organization',
  projectNumber: 1,
  query: '',
  first: 100,
  after: null,
  unsupportedFields: new Set<OptionalProjectItemField>(),
  host: 'acme.ghe.com'
} as const
const prText = '#1, #2, #3, #4, #5, #6, #7, #8, #9, #10 +2 more'
// The linked PR overflow renders in its own span, so match the element holding the whole cell text.
const cellText = (text: string) => (_: string, element: Element | null) =>
  element?.textContent === text &&
  !Array.from(element.children).some((child) => child.textContent === text)
const missingSummary = {
  extensions: { code: 'undefinedField', typeName: 'Issue', fieldName: 'subIssuesSummary' },
  message: "Field 'subIssuesSummary' doesn't exist on type 'Issue'"
}
const missingPrs = {
  extensions: { code: 'undefinedType', typeName: 'ProjectV2ItemFieldPullRequestValue' },
  message: "No such type ProjectV2ItemFieldPullRequestValue, so it can't be a fragment condition"
}
const missingParent = { type: 'FIELD_NOT_FOUND', path: ['parent'] }

function response(
  nodes: RawItem[],
  totalCount = nodes.length,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null
  }
) {
  return {
    stdout: JSON.stringify({
      data: {
        organization: {
          projectV2: {
            items: {
              totalCount,
              pageInfo,
              nodes
            }
          }
        }
      }
    }),
    stderr: ''
  }
}
function selectedResponse(arguments_: string[]) {
  const query = arguments_.join(' ')
  const content = { ...item.content }
  if (!query.includes('parent {')) {
    delete content.parent
  }
  if (!query.includes('subIssuesSummary {')) {
    delete content.subIssuesSummary
  }
  return response([
    {
      ...item,
      content,
      fieldValues: query.includes('... on ProjectV2ItemFieldPullRequestValue')
        ? item.fieldValues
        : { nodes: [] }
    }
  ])
}
beforeEach(() => {
  vi.clearAllMocks()
  _resetProjectViewCachesForTests()
  vi.mocked(ghExecFileAsync)
    .mockReset()
    .mockImplementation(async (arguments_) => selectedResponse(arguments_))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function normalized(raw: RawItem): GitHubProjectRow {
  const result = normalizeItem(raw, 0)
  if (!result.ok) {
    throw new Error('Expected a project row')
  }
  return result.row
}
function renderColumns(row: GitHubProjectRow): void {
  for (const [id, dataType] of [
    ['field-pr', 'LINKED_PULL_REQUESTS'],
    ['field-progress', 'SUB_ISSUES_PROGRESS']
  ] as const) {
    render(
      createElement(ProjectCell, {
        row,
        field: { kind: 'field', id, name: dataType, dataType },
        editable: false,
        sourceTarget: { kind: 'local' }
      })
    )
  }
}

describe('Project columns from the items response', () => {
  it.each([prText, '1/2 (50%)'])(
    'renders %s through one bounded items request on a named cloud host',
    async (expectedText) => {
      vi.mocked(ghExecFileAsync).mockResolvedValueOnce(
        response([
          {
            ...item,
            fieldValues: {
              nodes: [
                null,
                {
                  __typename: 'ProjectV2ItemFieldTextValue',
                  field: { id: 'notes' },
                  text: 'Keep this too'
                },
                ...(item.fieldValues?.nodes ?? [])
              ]
            }
          }
        ])
      )
      const page = await fetchItemsPageWithRaw(args)
      if (!page.ok || !page.page.nodes?.[0]) {
        throw new Error('Expected an items page')
      }
      const row = normalized(page.page.nodes[0])
      renderColumns(row)
      expect(screen.getByText(cellText(expectedText)).textContent).toBe(expectedText)
      expect(row.fieldValuesByFieldId).toEqual({
        notes: { kind: 'text', fieldId: 'notes', text: 'Keep this too' }
      })
      expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
      const query = vi.mocked(ghExecFileAsync).mock.calls[0][0].join(' ')
      expect(query).toContain('pullRequests(first:10)')
      expect(query).toContain('subIssuesSummary { completed total percentCompleted }')
      expect(query).not.toContain('ProjectV2ItemFieldProgressValue')
    }
  )

  it.each([
    { completed: 0, total: 2, percentCompleted: 0 },
    { completed: 2, total: 2, percentCompleted: 100 }
  ])('preserves zero and complete counters: %j', (summary) => {
    renderColumns(normalized({ ...item, content: { subIssuesSummary: summary } }))
    expect(
      screen.getByText(`${summary.completed}/2 (${summary.percentCompleted}%)`).textContent
    ).toBeTruthy()
  })

  it('keeps old-host, draft, PR, redacted and zero-total rows blank', () => {
    for (const raw of [
      { id: 'old', type: 'ISSUE', content: {} },
      { id: 'draft', type: 'DRAFT_ISSUE', content: {} },
      { id: 'pr', type: 'PULL_REQUEST', content: {} },
      { id: 'redacted', type: 'REDACTED', content: null },
      {
        id: 'empty',
        type: 'ISSUE',
        content: { subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 } }
      }
    ]) {
      renderColumns(normalized(raw))
    }
    expect(document.body.textContent).toBe('')
  })

  it.each([
    { errors: [missingSummary], parentDropped: false, summary: false, prs: true },
    { errors: [missingPrs], parentDropped: false, summary: true, prs: false },
    { errors: [missingParent], parentDropped: true, summary: true, prs: true },
    { errors: [missingSummary, missingPrs], parentDropped: false, summary: false, prs: false },
    {
      errors: [{ message: "Cannot query field 'subIssuesSummary' on type 'Issue'." }],
      parentDropped: false,
      summary: false,
      prs: true
    }
  ])('omits only unsupported selections: %j', async ({ errors, parentDropped, summary, prs }) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({ errors }),
      stderr: ''
    })
    const result = await fetchAllItems(args)
    if (!result.ok) {
      throw new Error('Expected compatibility fallback to succeed')
    }
    expect(result.parentFieldDropped).toBe(parentDropped)
    expect(result.rows[0].content.parentIssue).toEqual(parentDropped ? null : parent)
    expect(warning).toHaveBeenCalledTimes(parentDropped ? 1 : 0)
    renderColumns(result.rows[0])
    expect(Boolean(screen.queryByText('1/2 (50%)'))).toBe(summary)
    expect(Boolean(screen.queryByText(cellText(prText)))).toBe(prs)
    expect(ghExecFileAsync).toHaveBeenCalledTimes(2)
    const query = vi.mocked(ghExecFileAsync).mock.calls[1][0].join(' ')
    expect(query.includes('parent {')).toBe(!parentDropped)
    expect(query.includes('subIssuesSummary {')).toBe(summary)
    expect(query.includes('... on ProjectV2ItemFieldPullRequestValue')).toBe(prs)
    await fetchAllItems(args)
    expect(ghExecFileAsync).toHaveBeenCalledTimes(3)
    await fetchAllItems({ ...args, owner: 'another-owner' })
    expect(vi.mocked(ghExecFileAsync).mock.calls[3][0].join(' ')).toContain('subIssuesSummary {')
  })

  it('bounds sequential missing-field retries by the three optional selections', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const error of [missingSummary, missingPrs, missingParent]) {
      vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
        stdout: JSON.stringify({ errors: [error] }),
        stderr: ''
      })
    }
    expect(await fetchAllItems(args)).toMatchObject({ ok: true, parentFieldDropped: true })
    expect(ghExecFileAsync).toHaveBeenCalledTimes(4)
  })

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'RATE_LIMITED', 'NETWORK_ERROR'])(
    'never caches unrelated %s failures',
    async (type) => {
      vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
        stdout: JSON.stringify({ errors: [{ type, message: 'Cannot access subIssuesSummary' }] }),
        stderr: ''
      })
      expect(await fetchAllItems(args)).toMatchObject({ ok: false })
      expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
      expect(await fetchAllItems(args)).toMatchObject({ ok: true, parentFieldDropped: false })
      expect(vi.mocked(ghExecFileAsync).mock.calls[1][0].join(' ')).toContain('subIssuesSummary {')
    }
  )

  it('shares a pending owner capability probe between concurrent callers', async () => {
    let entered = () => {}
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(ghExecFileAsync).mockImplementationOnce(async () => {
      entered()
      await pending
      return { stdout: JSON.stringify({ errors: [missingSummary] }), stderr: '' }
    })
    const first = fetchAllItems(args)
    await started
    const second = fetchAllItems(args)
    expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
    release()
    const results = await Promise.all([first, second])
    expect(results).toEqual([
      expect.objectContaining({ ok: true, parentFieldDropped: false }),
      expect.objectContaining({ ok: true, parentFieldDropped: false })
    ])
    expect(ghExecFileAsync).toHaveBeenCalledTimes(3)
    expect(vi.mocked(ghExecFileAsync).mock.calls[2][0].join(' ')).not.toContain(
      'subIssuesSummary {'
    )
  })

  it('fetches unrelated projects concurrently when all optional selections are unsupported', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({ errors: [missingParent, missingSummary, missingPrs] }),
      stderr: ''
    })
    expect(await fetchAllItems(args)).toMatchObject({ ok: true, parentFieldDropped: true })
    vi.mocked(ghExecFileAsync).mockClear()
    let entered = () => {}
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(ghExecFileAsync).mockImplementationOnce(async (arguments_) => {
      entered()
      await pending
      return selectedResponse(arguments_)
    })
    const first = fetchAllItems(args)
    await started
    const second = fetchAllItems({ ...args, projectNumber: 2 })
    // Flush the normal request's async auth boundary without releasing the first response.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const concurrentCalls = vi.mocked(ghExecFileAsync).mock.calls.slice()
    release()
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: true, parentFieldDropped: true }),
      expect.objectContaining({ ok: true, parentFieldDropped: true })
    ])
    expect(concurrentCalls).toHaveLength(2)
    expect(
      concurrentCalls.map(([arguments_]) => arguments_.find((arg) => arg.startsWith('num=')))
    ).toEqual(['num=1', 'num=2'])
    for (const [arguments_] of concurrentCalls) {
      expect(arguments_.join(' ')).not.toMatch(
        /parent \{|subIssuesSummary \{|\.\.\. on ProjectV2ItemFieldPullRequestValue/
      )
    }
  })

  it('keeps supported fields and the cursor on pages after a capability retry', async () => {
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({ errors: [missingSummary] }),
      stderr: ''
    })
    const firstPage = JSON.parse(
      selectedResponse(['parent {', '... on ProjectV2ItemFieldPullRequestValue']).stdout
    )
    firstPage.data.organization.projectV2.items.pageInfo = { hasNextPage: true, endCursor: 'next' }
    firstPage.data.organization.projectV2.items.totalCount = 2
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify(firstPage),
      stderr: ''
    })
    expect(await fetchAllItems(args)).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ position: 0 }), expect.objectContaining({ position: 1 })]
    })
    const last = vi.mocked(ghExecFileAsync).mock.calls[2][0]
    expect(last).toContain('after=next')
    expect(last.join(' ')).not.toContain('subIssuesSummary {')
    expect(last.join(' ')).toContain('parent {')
    expect(last.join(' ')).toContain('... on ProjectV2ItemFieldPullRequestValue')
  })

  it.each([10, 12])('shows exact counts for a linked PR list with total %i', (totalCount) => {
    const row = normalized(item)
    if (!row.content.linkedPullRequests) {
      throw new Error('Expected linked PR content')
    }
    row.content.linkedPullRequests.totalCount = totalCount
    renderColumns(row)
    expect(
      screen.getByText(cellText(totalCount === 12 ? prText : prText.replace(' +2 more', '')))
        .textContent
    ).toBeTruthy()
  })

  it('preserves populated and legacy rows through shared sorting, grouping and cells', async () => {
    const result = await fetchAllItems(args)
    if (!result.ok) {
      throw new Error('Expected rows')
    }
    const populated = result.rows[0]
    populated.fieldValuesByFieldId.points = { kind: 'number', fieldId: 'points', number: 2 }
    const legacy = normalized({ id: 'legacy', type: 'ISSUE', content: { title: 'Older host' } })
    delete legacy.content.linkedPullRequests
    delete legacy.content.subIssuesProgress
    legacy.fieldValuesByFieldId.points = { kind: 'number', fieldId: 'points', number: 1 }
    const points = { kind: 'field', id: 'points', name: 'Points', dataType: 'NUMBER' } as const
    const prs = {
      kind: 'field',
      id: 'field-pr',
      name: 'Linked PRs',
      dataType: 'LINKED_PULL_REQUESTS'
    } as const
    const progress = {
      kind: 'field',
      id: 'field-progress',
      name: 'Progress',
      dataType: 'SUB_ISSUES_PROGRESS'
    } as const
    const table: GitHubProjectTable = {
      project: {
        id: 'P',
        owner: 'o',
        ownerType: 'organization',
        number: 1,
        title: 'Project',
        url: ''
      },
      selectedView: {
        id: 'V',
        number: 1,
        name: 'Table',
        layout: 'TABLE_LAYOUT',
        filter: '',
        fields: [points, prs, progress],
        groupByFields: [points],
        sortByFields: [{ field: points, direction: 'ASC' }]
      },
      rows: [populated, legacy],
      totalCount: 2,
      parentFieldDropped: false
    }
    const sorted = sortRows(table, table.rows)
    expect(sorted.map((row) => row.id)).toEqual(['legacy', 'item-1'])
    const groups = groupRows(table, sorted)
    expect(groups.map((group) => group.label)).toEqual(['1', '2'])
    renderColumns(groups[1].rows[0])
    expect(screen.getByText(cellText(prText))).toBeTruthy()
    expect(screen.getByText('1/2 (50%)')).toBeTruthy()
    cleanup()
    renderColumns(groups[0].rows[0])
    expect(document.body.textContent).toBe('')
    cleanup()
    // Existing builtin ordering still uses the field map, with no new relation value kind.
    for (const field of [prs, progress]) {
      const relationTable = {
        ...table,
        selectedView: {
          ...table.selectedView,
          groupByFields: [field],
          sortByFields: [{ field, direction: 'ASC' as const }]
        }
      }
      expect(sortRows(relationTable, table.rows).map((row) => row.id)).toEqual(['item-1', 'legacy'])
      expect(groupRows(relationTable, table.rows).map((group) => group.key)).toEqual(['__empty__'])
    }
  })

  it.each([50, 500])(
    'normalizes %i ten-PR rows with linear work and page requests',
    async (count) => {
      let prNodeReads = 0
      const normalize = fieldNormalization.normalizeLinkedPullRequests
      const normalizer = vi
        .spyOn(fieldNormalization, 'normalizeLinkedPullRequests')
        .mockImplementation((raw) => {
          for (const node of raw.pullRequests?.nodes ?? []) {
            if (node) {
              const number = node.number
              Object.defineProperty(node, 'number', {
                get() {
                  prNodeReads++
                  return number
                }
              })
            }
          }
          return normalize(raw)
        })
      const corpus = Array.from({ length: count }, (_, i) => ({ ...item, id: `item-${i}` }))
      vi.mocked(ghExecFileAsync).mockImplementation(async (arguments_) => {
        const after = arguments_.find((arg) => arg.startsWith('after='))
        const offset = after ? Number(after.slice('after='.length)) : 0
        expect(offset).toBe((vi.mocked(ghExecFileAsync).mock.calls.length - 1) * 100)
        const end = Math.min(offset + 100, count)
        return response(corpus.slice(offset, end), count, {
          hasNextPage: end < count,
          endCursor: end < count ? String(end) : null
        })
      })
      const result = await fetchAllItems(args)
      if (!result.ok) {
        throw new Error('Expected paginated rows')
      }
      expect(result.rows).toHaveLength(count)
      expect(result.rows.at(-1)?.position).toBe(count - 1)
      expect(normalizer).toHaveBeenCalledTimes(count)
      expect(prNodeReads).toBe(count * 10 * 2) // Validation and copying each returned PR number.
      expect(ghExecFileAsync).toHaveBeenCalledTimes(Math.ceil(count / 100))
      for (const [arguments_] of vi.mocked(ghExecFileAsync).mock.calls) {
        expect(arguments_.join(' ')).toContain('pullRequests(first:10)')
      }
      renderColumns(result.rows[count - 1])
      expect(screen.getByText(cellText(prText))).toBeTruthy()
    }
  )
})
