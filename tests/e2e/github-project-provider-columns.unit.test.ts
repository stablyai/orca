// @vitest-environment happy-dom

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeItem,
  type RawItem
} from '../../src/main/github/project-view/project-view-item-normalization'
import '../../src/main/github/project-view/project-view-item-page'
import { fetchAllItems } from '../../src/main/github/project-view/project-view-items'
import {
  _resetProjectViewCachesForTests,
  type OptionalProjectItemField
} from '../../src/main/github/project-view/project-view-cache'
import { ghExecFileAsync } from '../../src/main/github/project-view/internals'
import type { GitHubProjectRow } from '../../src/shared/github/project-types'
import { normalizeLinkedPullRequests } from '../../src/main/github/project-view/project-view-field-normalization'
import { projectRelationsTableFixture } from '../../src/shared/github/project-relations.test-fixture'
import { sortRows } from '../../src/shared/github/project-group-sort'

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
})

it('sorts linked PRs by their first number and treats count-only metadata as an unknown sort key', () => {
  const field = {
    kind: 'field',
    id: 'prs',
    name: 'Linked pull requests',
    dataType: 'LINKED_PULL_REQUESTS'
  } as const
  const rows = ['ten', 'two-high', 'count-only', 'two-low', 'absent'].map((id, position) => ({
    ...normalized({ id, type: 'ISSUE', content: { title: id } }),
    position
  }))
  const table = projectRelationsTableFixture()
  table.rows = rows
  for (const [index, numbers] of [
    [0, [10]],
    [1, [2, 100]],
    [3, [2, 9]]
  ] as const) {
    rows[index].content.linkedPullRequests = {
      pullRequests: numbers.map((number) => ({
        number,
        title: 'PR',
        url: `https://github.com/acme/repo/pull/${number}`
      })),
      totalCount: numbers.length
    }
  }
  rows[2].content.linkedPullRequests = normalizeLinkedPullRequests({
    __typename: 'ProjectV2ItemFieldPullRequestValue',
    pullRequests: { nodes: [null, {}], totalCount: 3 }
  })
  for (const [direction, expected] of [
    ['ASC', ['two-high', 'two-low', 'ten', 'count-only', 'absent']],
    ['DESC', ['ten', 'two-high', 'two-low', 'count-only', 'absent']]
  ] as const) {
    expect(
      sortRows(
        {
          ...table,
          selectedView: { ...table.selectedView, sortByFields: [{ field, direction }] }
        },
        rows
      ).map((row) => row.id)
    ).toEqual(expected)
  }
})
